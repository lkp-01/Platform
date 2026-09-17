/** Minimal task admission and attribution; Harness remains the execution owner. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { tokenSchema } from './definition.ts'
import { RegistryError, type AgentRegistry } from './registry.ts'
import { historyPage, type AgentVersions } from './versions.ts'
import type { AgentDeployments } from './deployments.ts'
import type { AgentHistoryPage, AgentVersion, PlatformRun, PlatformRunId } from './types.ts'

import { runSchema, runStatusSchema, type RunRecord } from './run-schema.ts'
import { isRunTerminal, projectRun, transitionRun } from './run-lifecycle.ts'
import type { RunStatus } from './types.ts'

const spec = defineDomain({ name: 'platform_agent_runs', version: 1, tables: { runs: domainTable<string, RunRecord>(runSchema) } })

/** Resolve the exact captured model proposal without current Host selections.
 * @param version - immutable version.
 * @returns frozen route and supported sampling parameters.
 */
export function versionCallConfig(version: AgentVersion): LlmCallConfig {
  const params = version.snapshot.executionConfig.modelParameters
  return { provider: version.snapshot.model.provider, model: version.snapshot.model.model,
    ...(params.reasoningEffort === null ? {} : { reasoningEffort: ReasoningEffortId(params.reasoningEffort) }),
    ...(params.temperature === null ? {} : { temperature: params.temperature }),
    ...(params.maxTokens === null ? {} : { maxTokens: params.maxTokens }),
    ...(params.stop === null ? {} : { stop: [...params.stop] }),
  }
}

function publicRun(row: z.infer<typeof runSchema>): PlatformRun {
  const { fingerprint: _fingerprint, format: _format, lastSessionSeq: _seq, ...run } = row
  return structuredClone(run)
}

/** Persistent single-Host task lifecycle around the original Harness Agent Loop. */
export class PlatformRuns {
  private readonly admissions = new Set<Promise<PlatformRun>>()
  private readonly launching = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly faults = new Map<string, unknown>()
  private readonly sessions = new Map<string, string>()
  private closing = false
  private unlisten: (() => void) | undefined
  private constructor(private readonly ctx: Context, private readonly domain: Domain<typeof spec>, private readonly registry: AgentRegistry,
    private readonly versions: AgentVersions, private readonly deployments: AgentDeployments) {}

  /** Open storage, reconcile previous admissions, and observe execution facts.
   * @param ctx - injected Harness and storage services.
   * @param registry - resource authority and admission serialization.
   * @param versions - immutable snapshot authority.
   * @param deployments - default activation authority.
   * @returns task runtime; no previous task is resubmitted.
   */
  static async open(ctx: Context, registry: AgentRegistry, versions: AgentVersions, deployments: AgentDeployments): Promise<PlatformRuns> {
    const runtime = new PlatformRuns(ctx, await ctx.storageDomain.open(spec), registry, versions, deployments)
    try {
      for (const [id, row] of runtime.domain.table('runs').entries()) runtime.sessions.set(row.sessionId, id)
      runtime.unlisten = ctx.on('session/event', (session, event) => {
        const id = runtime.sessions.get(session.id)
        if (id === undefined || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
        runtime.enqueue(id, () => runtime.project(id, session))
      })
      for (const [id, row] of runtime.domain.table('runs').entries()) {
        if (row.format === 1 || !isRunTerminal(row.status)) await runtime.reconcile(id)
      }
      return runtime
    } catch (error) { runtime.unlisten?.(); await runtime.domain.close(); throw error }
  }

  /** Stop admitted work and drain lifecycle writes before closing persistence. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.admissions)
    await Promise.all(this.launching.values())
    for (const [, row] of this.domain.table('runs').entries()) {
      if (isRunTerminal(row.status)) continue
      const agent = this.ctx.agents.get(row.sessionId)
      if (agent !== undefined) { agent.cancel({ kind: 'disposed' }); await agent.whenIdle(); await this.project(row.id, agent.session) }
      if (!isRunTerminal(this.record(row.id).status)) await this.fail(row.id, 'EXECUTION_INTERRUPTED', 'Runtime stopped')
    }
    this.unlisten?.()
    await Promise.all(this.pending.values())
    await this.domain.close()
  }

  private enqueue(id: string, operation: () => Promise<void>): void {
    const next = (this.pending.get(id) ?? Promise.resolve()).then(operation).then(() => { this.faults.delete(id) }, (error: unknown) => {
      this.faults.set(id, error)
      this.ctx.logger.error('Run lifecycle persistence failed for %s: %s', id, String(error))
    })
    this.pending.set(id, next)
    void next.then(() => { if (this.pending.get(id) === next) this.pending.delete(id) })
  }

  private async project(id: string, session: Session): Promise<void> {
    const events = session.snapshotEvents()
    await this.ctx.sessions.flush(session)
    await this.domain.table('runs').update(id, row => projectRun(row, events, new Date().toISOString()))
  }

  private record(id: string): RunRecord {
    const row = this.domain.table('runs').get(id)
    if (row === undefined) throw new RegistryError('not-found', 'Run not found')
    return row
  }

  private async fail(id: string, code: string, message: string): Promise<void> {
    await this.domain.table('runs').update(id, row => transitionRun(row, 'FAILED', new Date().toISOString(), {
      error: { code, message }, finishTimeSource: code === 'EXECUTION_INTERRUPTED' ? 'detected' : 'execution',
    }))
  }

  private async reconcile(id: string): Promise<void> {
    const stored = this.record(id)
    const live = this.ctx.agents.get(stored.sessionId)
    let events: readonly import('@deepseek-ai/dsh-session').SessionEvent[] = []
    if (live !== undefined) {
      events = live.session.snapshotEvents()
      await this.ctx.sessions.flush(live.session)
    } else {
      try { using observed = await this.ctx.sessionQuery.observeSession(stored.sessionId); events = observed.events }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }
    await this.domain.table('runs').update(id, (current) => {
      let row = current
      if (row.format === 1) {
        row = { ...row, format: 2, events: [{ eventId: `${row.id}:0`, runId: row.id, agentId: row.agentId,
          agentVersionId: row.agentVersionId, sessionId: row.sessionId, type: 'run.created', occurredAt: row.createdAt }] }
        if (events.some(event => event.type === 'turn/start')) row = { ...row, status: 'PENDING', error: null }
        else if (row.status === 'FAILED' && row.error === null) row = { ...row, error: { code: 'EXECUTION_INTERRUPTED', message: 'Legacy execution interrupted' } }
      }
      row = projectRun(row, events, new Date().toISOString())
      if (!isRunTerminal(row.status) && live?.status !== 'running' && !this.launching.has(id)) {
        row = transitionRun(row, 'FAILED', new Date().toISOString(), {
          error: { code: 'EXECUTION_INTERRUPTED', message: 'Execution ended without a durable completion' }, finishTimeSource: 'detected',
        })
      }
      return row
    })
  }

  /** Identify managed Sessions without reading their transcripts.
   * @param sessionId - Harness Session identity.
   * @returns stored task, or undefined for ordinary Sessions.
   */
  forSession(sessionId: string): PlatformRun | undefined {
    const id = this.sessions.get(sessionId)
    const row = id === undefined ? undefined : this.domain.table('runs').get(id)
    return row === undefined ? undefined : publicRun(row)
  }

  /** Guard versioned Session creation with its accepted task.
   * @param sessionId - proposed Harness identity.
   * @param preset - immutable version composition.
   */
  assertCreation(sessionId: string, preset: string): void {
    const run = this.forSession(sessionId)
    if (run === undefined || run.agentVersionId !== preset || !this.launching.has(run.id) || isRunTerminal(run.status)) {
      throw new RegistryError('conflict', 'Start versioned tasks from the Agent Run entry')
    }
  }

  private read(workspace: string, agentId: string, runId: string): RunRecord {
    this.registry.get(workspace, agentId)
    const row = this.domain.table('runs').get(runId)
    if (row === undefined || row.agentId !== agentId || row.platformWorkspaceId !== workspace) throw new RegistryError('not-found', 'Run not found')
    return row
  }

  /** Read durable lifecycle facts after already observed events have settled.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param runId - task identity.
   * @returns persisted Run, without scanning the transcript on normal reads.
   */
  async get(workspace: string, agentId: string, runId: string): Promise<PlatformRun> {
    this.read(workspace, agentId, runId)
    await this.pending.get(runId)
    if (this.faults.has(runId)) { await this.reconcile(runId); this.faults.delete(runId) }
    return publicRun(this.read(workspace, agentId, runId))
  }

  /** List newest tasks from the Run index.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param cursor - page offset.
   * @param versionId - optional exact version.
   * @param status - optional lifecycle status.
   * @returns bounded task page.
   */
  async list(
    workspace: string, agentId: string, cursor: number, versionId?: string, status?: RunStatus,
  ): Promise<AgentHistoryPage<PlatformRun>> {
    this.registry.get(workspace, agentId)
    if (status !== undefined) runStatusSchema.parse(status)
    const selected = [...this.domain.table('runs').entries()].filter(([, row]) => row.agentId === agentId && row.platformWorkspaceId === workspace)
    await Promise.all(selected.map(([id]) => this.pending.get(id)))
    for (const [id] of selected) if (this.faults.has(id)) { await this.reconcile(id); this.faults.delete(id) }
    const rows = selected.map(([id]) => this.record(id))
      .filter(row => (versionId === undefined || row.agentVersionId === versionId) && (status === undefined || row.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const page = historyPage(rows, cursor)
    return { nextCursor: page.nextCursor, items: page.items.map(publicRun) }
  }

  /** Accept one task, then prepare and launch it in this Host.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param prompt - task input.
   * @param token - idempotent admission identity.
   * @param prepare - frozen-version artifact preparation.
   * @returns durable admission; preparation failures are retained on the Run.
   */
  async start(
    workspace: string, agentId: string, prompt: string, token: string, prepare: (version: AgentVersion) => Promise<void>,
  ): Promise<PlatformRun> {
    tokenSchema.parse(token); z.string().min(1).max(32000).refine(value => value.trim().length > 0).parse(prompt)
    if (this.closing) throw new RegistryError('conflict', 'Runtime is stopping')
    const admission = this.registry.exclusive(workspace, agentId, async () => {
      if (this.closing) throw new RegistryError('conflict', 'Runtime is stopping')
      const id = brandString<PlatformRunId>(`run-${createHash('sha256').update(JSON.stringify([workspace, agentId, token])).digest('hex').slice(0, 32)}`)
      const fingerprint = createHash('sha256').update(prompt).digest('hex')
      const previous = this.domain.table('runs').get(id)
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw new RegistryError('conflict', 'Run request token already used for different input')
        return this.get(workspace, agentId, id)
      }
      const agent = this.registry.get(workspace, agentId)
      if (agent.lifecycle === 'archived') throw new RegistryError('archived', 'Restore this Agent before starting a Run')
      const deployment = this.deployments.get(workspace, agentId)
      if (deployment === null) throw new RegistryError('conflict', 'Deploy a saved version before starting a Run')
      const version = this.versions.get(workspace, agentId, deployment.versionId)
      const row = runSchema.parse({ id, agentId: agent.id, platformWorkspaceId: workspace, agentVersionId: version.id,
        versionNumber: version.versionNumber, configHash: version.configHash, deploymentRevision: deployment.revision,
        sessionId: `session-${id}`, createdAt: new Date().toISOString(), createdBy: 'shared-host', status: 'PENDING',
        error: null, fingerprint, format: 2, input: { prompt } })
      row.events.push({ eventId: `${id}:0`, runId: id, agentId: agent.id, agentVersionId: version.id,
        sessionId: row.sessionId, type: 'run.created', occurredAt: row.createdAt })
      await this.domain.table('runs').put(id, row)
      this.sessions.set(row.sessionId, id)
      const launch = Promise.resolve().then(() => this.launch(row, version, prepare)).catch((error: unknown) => {
        this.faults.set(id, error)
        this.ctx.logger.error('Run launch settlement failed for %s: %s', id, String(error))
      }).finally(() => { this.launching.delete(id) })
      this.launching.set(id, launch)
      return publicRun(row)
    })
    this.admissions.add(admission)
    try { return await admission } finally { this.admissions.delete(admission) }
  }

  private async launch(row: RunRecord, version: AgentVersion, prepare: (version: AgentVersion) => Promise<void>): Promise<void> {
    const allowed = () => !this.closing && !isRunTerminal(this.record(row.id).status)
    try {
      if (row.input === null) throw new Error('Accepted Run input is missing')
      if (!allowed()) return
      await prepare(version)
      if (!allowed()) return
      await this.ctx.sessionController.create({ sessionId: row.sessionId, agentPreset: version.id })
      if (!allowed()) return
      const harness = this.ctx.agents.get(row.sessionId)
      if (harness === undefined) throw new Error('Harness did not create the accepted Session')
      harness.session.append('platform/run', { runId: row.id, agentId: row.agentId, agentVersionId: version.id,
        platformWorkspaceId: row.platformWorkspaceId, configHash: version.configHash, deploymentRevision: row.deploymentRevision })
      await this.ctx.sessions.flush(harness.session)
      // The domain write queue serializes this final check with cancellation.
      await this.domain.table('runs').update(row.id, current => current)
      if (!allowed() || this.record(row.id).cancelRequestedAt !== null) return
      harness.followup(createUserMessage({ content: [{ type: 'text', text: row.input.prompt }], source: { kind: 'user' } }))
    } catch (error) {
      await this.fail(row.id, 'START_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  /** Request cancellation; execution completion, not the click, decides the terminal status.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param runId - task identity.
   * @returns persisted current state with cancellation intent.
   */
  async cancel(workspace: string, agentId: string, runId: string): Promise<PlatformRun> {
    const current = await this.get(workspace, agentId, runId)
    if (isRunTerminal(current.status)) return current
    const row = await this.domain.table('runs').update(runId, (current) => {
      if (isRunTerminal(current.status)) return current
      const at = new Date().toISOString()
      const next = { ...current, cancelRequestedAt: current.cancelRequestedAt ?? at }
      const live = this.ctx.agents.get(current.sessionId)
      return current.status === 'PENDING' && live?.status !== 'running' ? transitionRun(next, 'CANCELLED', at) : next
    })
    if (!isRunTerminal(row.status)) {
      const agent = this.ctx.agents.get(row.sessionId)
      if (agent === undefined) await this.reconcile(runId)
      else agent.cancel({ kind: 'user' })
    }
    return this.get(workspace, agentId, runId)
  }
}
