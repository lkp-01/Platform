import { GovernanceError } from './governance.ts'
import { platformActor } from './principal-context.ts'
/** Minimal task admission and attribution; Harness remains the execution owner. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { freezeMessage, createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { RuntimeTools, RecoveryBlocked } from './runtime-tools.ts'
import { runtimePolicySchema, type RuntimePolicy } from './runtime-policy.ts'
import type {} from '@deepseek-ai/dsh-session-query'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { tokenSchema } from './definition.ts'
import { RegistryError, type AgentRegistry } from './registry.ts'
import { historyPage, type AgentVersions } from './versions.ts'
import type { AgentDeployments } from './deployments.ts'
import type { AgentHistoryPage, AgentVersion, PlatformRun, PlatformRunId } from './types.ts'

import { runSchema, runStatusSchema, reliableRun, type RunRecord } from './run-schema.ts'
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
  const { fingerprint: _fingerprint, format: _format, lastSessionSeq: _seq, policy: _policy, ...run } = row
  return structuredClone(run)
}

/** Persistent single-Host task lifecycle around the original Harness Agent Loop. */
export class PlatformRuns {
  private stopped: Promise<void> | undefined
  private readonly admissions = new Set<Promise<PlatformRun>>()
  private readonly launching = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly faults = new Map<string, unknown>()
  private readonly sessions = new Map<string, string>()
  private closing = false
  private unlisten: (() => void) | undefined
  private tools!: RuntimeTools
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  private pollTask: Promise<void> = Promise.resolve()
  private authorize: ((run: PlatformRun) => void) | undefined
  private prepare: ((version: AgentVersion) => Promise<void>) | undefined
  private policy: RuntimePolicy = runtimePolicySchema.parse({})
  private lease: SessionWriteLease | undefined
  private constructor(private readonly ctx: Context, private readonly domain: Domain<typeof spec>, private readonly registry: AgentRegistry,
    private readonly versions: AgentVersions, private readonly deployments: AgentDeployments) {}

  /** Open storage, reconcile previous admissions, and observe execution facts.
   * @param ctx - injected Harness and storage services.
   * @param registry - resource authority and admission serialization.
   * @param versions - immutable snapshot authority.
   * @param deployments - default activation authority.
   * @param root - shared single-Host runtime ownership directory.
   * @returns task runtime; startWorkers activates durable admissions after plugin setup.
   */
  static async open(
    ctx: Context, registry: AgentRegistry, versions: AgentVersions, deployments: AgentDeployments, root: string,
  ): Promise<PlatformRuns> {
    const lease = await SessionWriteLease.acquire(resolve(root, '.runtime-owner'), SessionId('platform-runtime'))
    let domain: Domain<typeof spec>
    try { domain = await ctx.storageDomain.open(spec) } catch (error) { await lease.release(); throw error }
    const runtime = new PlatformRuns(ctx, domain, registry, versions, deployments)
    runtime.lease = lease
    try {
      for (const [id, row] of runtime.domain.table('runs').entries()) runtime.sessions.set(row.sessionId, id)
      runtime.unlisten = ctx.on('session/event', (session, event) => {
        const id = runtime.sessions.get(session.id)
        if (id === undefined || runtime.record(id).runtime !== undefined || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
        runtime.enqueue(id, () => runtime.project(id, session))
      })
      runtime.tools = await RuntimeTools.open(ctx, (sessionId) => {
        const id = runtime.sessions.get(sessionId)
        return id === undefined ? undefined : runtime.record(id)
      }, run => runtime.authorize?.(publicRun(run)))
      return runtime
    } catch (error) { runtime.unlisten?.(); await runtime.domain.close(); await lease.release(); throw error }
  }

  /** Verify Run references before allowing a governed runtime to start workers. */
  validateOwnership(): void {
    const sessions = new Set<string>()
    for (const [, row] of this.domain.table('runs').entries()) {
      this.versions.get(row.platformWorkspaceId, row.agentId, row.agentVersionId)
      if (sessions.has(row.sessionId)) throw new Error('Session belongs to multiple Runs')
      sessions.add(row.sessionId)
    }
  }

  /** Activate bounded workers after the owning plugin has installed its policies.
   * @param policy - resolved deployment limits.
   * @param prepare - immutable version composition preparation.
   * @param authorize - current execution authorization barrier.
   */
  startWorkers(policy: RuntimePolicy, prepare: (version: AgentVersion) => Promise<void>, authorize?: (run: PlatformRun) => void): void {
    this.authorize = authorize
    this.policy = policy
    this.prepare = prepare
    this.timer = setInterval(() => {
      if (this.polling || this.closing) return
      this.pollTask = this.poll().catch((error: unknown) => { this.ctx.logger.error('Runtime scheduler: %s', String(error)) })
    }, policy.pollMs)
    this.timer.unref()
  }

  private async poll(): Promise<void> {
    const prepare = this.prepare
    if (this.closing || this.polling || prepare === undefined) return
    this.polling = true
    try {
      for (const [id, stored] of this.domain.table('runs').entries()) {
        if (isRunTerminal(stored.status) || this.launching.has(id)) continue
        if (stored.runtime === undefined) { await this.reconcile(id); continue }
        if (stored.status === 'BLOCKED') continue
        if (stored.cancelRequestedAt !== null) {
          await this.domain.table('runs').update(id, row => transitionRun(row, 'CANCELLED', new Date().toISOString()))
          continue
        }
        if (Date.now() >= Date.parse(stored.runtime.deadlineAt)) { await this.fail(id, 'DEADLINE_EXCEEDED', 'Run deadline exceeded'); continue }
        if (stored.runtime.nextAttemptAt !== null && Date.now() < Date.parse(stored.runtime.nextAttemptAt)) continue
        if (this.launching.size >= this.policy.concurrency) break
        const run = await this.domain.table('runs').update(id, row => ({ ...row,
          runtime: { ...reliableRun(row).runtime, attempt: reliableRun(row).runtime.attempt + 1,
            heartbeatAt: new Date().toISOString(), nextAttemptAt: null },
        }))
        if (reliableRun(run).runtime.attempt > reliableRun(run).policy.maxAttempts) { await this.fail(id, 'ATTEMPTS_EXHAUSTED', 'Run recovery budget exhausted'); continue }
        const job = Promise.resolve().then(async () => {
          await this.tools.applyResolution(run)
          // Reconcile completion before admitting another model or tool operation.
          await this.restoreResults(run)
          if (isRunTerminal(this.record(id).status)) return
          const version = this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId)
          this.authorize?.(publicRun(this.record(id)))
          await this.launch(this.record(id), version, prepare)
        }).catch(async (error: unknown) => {
          if (error instanceof RecoveryBlocked) {
            await this.domain.table('runs').update(id, row => transitionRun(row, 'BLOCKED', new Date().toISOString(), {
              error: { code: 'RECOVERY_BLOCKED', message: error.message },
            }))
          } else await this.fail(id, error instanceof GovernanceError ? 'AUTHORIZATION_REVOKED' : 'RECOVERY_FAILED', error instanceof GovernanceError ? 'Execution permission revoked' : String(error))
        }).catch((error: unknown) => {
          this.faults.set(id, error)
          this.ctx.logger.error('Runtime persistence failed for %s: %s', id, String(error))
        }).finally(() => { this.launching.delete(id) })
        this.launching.set(id, job)
      }
    } finally { this.polling = false }
  }

  private async checkpoint(id: string, attempt: number, session: Session): Promise<void> {
    await this.tools.drain(id)
    const seq = session.seq - 1
    await this.ctx.sessions.flush(session)
    await this.domain.table('runs').update(id, row => row.runtime?.attempt !== attempt ? row : { ...row,
      runtime: { ...row.runtime, checkpointSeq: seq, checkpointAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() },
    })
    const row = this.record(id)
    if (!isRunTerminal(row.status) && Date.now() >= Date.parse(reliableRun(row).runtime.deadlineAt)) {
      this.ctx.agents.get(row.sessionId)?.cancel({ kind: 'disposed' })
    }
  }

  private async setRetry(id: string): Promise<void> {
    const at = this.tools.retryAt(id)
    if (at === null) return
    await this.domain.table('runs').update(id, row => transitionRun(row, 'RETRY_WAIT', new Date().toISOString(), {
      runtime: { ...reliableRun(row).runtime, nextAttemptAt: new Date(at).toISOString() },
    }))
  }

  private async restoreResults(row: RunRecord): Promise<void> {
    if (this.ctx.agents.get(row.sessionId) !== undefined) return
    let handle
    try { handle = await this.ctx.sessionPersistence.open(row.sessionId, 'write') }
    catch (error) { if (error instanceof SessionPersistenceNotFoundError) return; throw error }
    try {
      const events = [...(await handle.read()).events]
      const pending = new Map<string, { call: SessionEvent<'tool/call'>['data']; seq: number | undefined }>()
      for (const event of events) {
        if (event.type === 'assistant/message') {
          for (const block of event.data.message.content) if (block.type === 'tool-call') {
            pending.set(block.id, { call: { turn: event.data.turn, step: event.data.step, callId: block.id,
              name: block.name, arguments: block.arguments }, seq: undefined })
          }
        }
        if (event.type === 'tool/call') pending.set(event.data.callId, { call: event.data, seq: event.seq })
        if (event.type === 'tool/result') pending.delete(event.data.message.source.callId)
      }
      for (const { call, seq } of pending.values()) {
        const recorded = this.tools.calls(row.id).find(item => item.callId === call.callId)
        if (recorded === undefined) {
          // No durable dispatch intent means our wrapper never entered the body.
          await this.tools.prepareUnstarted(row.id, call)
          continue
        }
        const result = this.tools.result(recorded)
        if (result === undefined || seq === undefined) continue
        const event: SessionEvent<'tool/result'> = { type: 'tool/result', seq: SessionSeq(events.length), time: Date.now(),
          sourceEventSeqs: [SessionSeq(seq)], surfaceOp: 'append', data: { turn: call.turn, step: call.step,
            message: createToolResultMessage({ callId: call.callId, content: result.content, isError: result.isError }),
            ...(result.error?.info === undefined ? {} : { error: result.error.info }),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
          } }
        await handle.append([event]); events.push(event)
      }
      await handle.flush()
      await this.domain.table('runs').update(row.id, current => projectRun(current, events, new Date().toISOString()))
    } finally { await handle.close() }
  }

  /** Stop admitted work and drain lifecycle writes before closing persistence. */
  async close(): Promise<void> {
    try { await this.stop() }
    finally {
      try { await this.tools.close() }
      finally { try { await this.domain.close() } finally { await this.lease?.release() } }
    }
  }

  /** Stop producers while keeping durable facts readable by draining observers. */
  stop(): Promise<void> { return this.stopped ??= this.stopExecution() }

  private async stopExecution(): Promise<void> {
    this.closing = true
    clearInterval(this.timer)
    // Capture legacy work before awaiting anything: whole-Host disposal also closes
    // Storage Domain, so shutdown must not enumerate it after workers have drained.
    const legacy: RunRecord[] = []
    try { for (const [, row] of this.domain.table('runs').entries()) if (row.runtime === undefined) legacy.push(row) }
    catch { /* The owning facility may already have closed its records. */ }
    await Promise.allSettled(this.admissions)
    await this.pollTask
    for (const sessionId of this.sessions.keys()) {
      this.ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'disposed' }, { keepInbox: true })
    }
    await Promise.allSettled(this.launching.values())
    for (const row of legacy) {
      try {
        if (isRunTerminal(row.status)) continue
        const agent = this.ctx.agents.get(row.sessionId)
        if (agent !== undefined) { agent.cancel({ kind: 'disposed' }); await agent.whenIdle(); await this.project(row.id, agent.session) }
        if (!isRunTerminal(this.record(row.id).status)) await this.fail(row.id, 'EXECUTION_INTERRUPTED', 'Runtime stopped')
      } catch (error) { this.ctx.logger.error('Legacy Run shutdown reconciliation: %s', String(error)) }
    }
    this.unlisten?.()
    await Promise.all(this.pending.values())
  }

  private enqueue(id: string, operation: () => Promise<void>): void {
    const next = (this.pending.get(id) ?? Promise.resolve()).then(operation).then(() => { this.faults.delete(id) }, (error: unknown) => {
      this.faults.set(id, error)
      this.ctx.agents.get(this.record(id).sessionId)?.cancel({ kind: 'disposed' }, { keepInbox: true })
      this.ctx.logger.error('Run lifecycle persistence failed for %s: %s', id, String(error))
    })
    this.pending.set(id, next)
    void next.then(() => { if (this.pending.get(id) === next) this.pending.delete(id) })
  }

  private async project(id: string, session: Session): Promise<void> {
    const events = await this.readSession(session)
    await this.domain.table('runs').update(id, row => projectRun(row, events, new Date().toISOString()))
  }

  private async readSession(session: Session): Promise<readonly SessionEvent[]> {
    // Recovery and final-outcome reconciliation require canonical history, read explicitly from storage.
    await this.ctx.sessions.flush(session)
    const handle = await this.ctx.sessionPersistence.open(session.id, 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
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
      events = await this.readSession(live.session)
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
      if (row.runtime === undefined && !isRunTerminal(row.status) && live?.status !== 'running' && !this.launching.has(id)) {
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

  /** Read tool attempt facts after authorization of their owning Run.
   * @param run - authorized Run.
   * @returns durable invocation metadata for the Trace projection.
   */
  toolHistory(run: PlatformRun): ReturnType<RuntimeTools['calls']> { return this.tools.calls(run.id) }

  /** Snapshot lifecycle attribution for the internal derived analytics reader.
   * @returns durable Run records without transcript reads.
   */
  analysisRuns(): PlatformRun[] { return [...this.domain.table('runs').entries()].map(([, row]) => publicRun(row)) }

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
   * @param createdBy - optional caller filter before pagination.
   * @returns bounded task page.
   */
  async list(
    workspace: string, agentId: string, cursor: number, versionId?: string, status?: RunStatus, createdBy?: string,
  ): Promise<AgentHistoryPage<PlatformRun>> {
    this.registry.get(workspace, agentId)
    if (status !== undefined) runStatusSchema.parse(status)
    const selected = [...this.domain.table('runs').entries()].filter(([, row]) => row.agentId === agentId && row.platformWorkspaceId === workspace)
    await Promise.all(selected.map(([id]) => this.pending.get(id) ?? Promise.resolve()))
    for (const [id] of selected) if (this.faults.has(id)) { await this.reconcile(id); this.faults.delete(id) }
    const rows = selected.map(([id]) => this.record(id))
      .filter(row => (createdBy === undefined || row.createdBy === createdBy)
        && (versionId === undefined || row.agentVersionId === versionId) && (status === undefined || row.status === status))
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
      const id = brandString<PlatformRunId>(`run-${createHash('sha256').update(JSON.stringify([workspace, agentId, ...(platformActor() === 'shared-host' ? [] : [platformActor()]), token])).digest('hex').slice(0, 32)}`)
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
      const row = runSchema.parse({ id, agentId: agent.id, platformWorkspaceId: workspace, agentVersionId: version.id, ownerTeamIdAtStart: agent.ownerTeamId,
        versionNumber: version.versionNumber, configHash: version.configHash, deploymentRevision: deployment.revision,
        sessionId: `session-${id}`, createdAt: new Date().toISOString(), createdBy: platformActor(), status: 'PENDING',
        error: null, fingerprint, format: 3, input: { prompt }, policy: this.policy,
        runtime: { attempt: 0, heartbeatAt: null, checkpointSeq: -1, checkpointAt: null, nextAttemptAt: null,
          deadlineAt: new Date(Date.now() + this.policy.deadlineMs).toISOString(), resolution: null } })
      row.events.push({ eventId: `${id}:0`, runId: id, agentId: agent.id, agentVersionId: version.id,
        sessionId: row.sessionId, type: 'run.created', occurredAt: row.createdAt })
      await this.domain.table('runs').put(id, row)
      this.sessions.set(row.sessionId, id)
      this.prepare ??= prepare
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
      this.authorize?.(publicRun(row))
      await prepare(version)
      if (!allowed()) return
      this.authorize?.(publicRun(row))
      this.tools.assertRecoverable(row.id)
      let cwd = this.ctx.agents.get(row.sessionId)?.session.header.cwd
      if (cwd === undefined) {
        try { cwd = (await this.ctx.sessionPersistence.stat(row.sessionId))?.header.cwd }
        catch (error) { if (!(error instanceof SessionPersistenceNotFoundError)) throw error }
      }
      await this.ctx.sessionController.create({ sessionId: row.sessionId, agentPreset: version.id,
        ...(cwd === undefined ? {} : { cwd }),
      })
      if (!allowed()) return
      const harness = this.ctx.agents.get(row.sessionId)
      if (harness === undefined) throw new Error('Harness did not create the accepted Session')
      if (!(await this.readSession(harness.session)).some(event => event.type === 'platform/run')) {
        harness.session.append('platform/run', { runId: row.id, agentId: row.agentId, agentVersionId: version.id,
          platformWorkspaceId: row.platformWorkspaceId, configHash: version.configHash, deploymentRevision: row.deploymentRevision })
      }
      await this.ctx.sessions.flush(harness.session)
      // The domain write queue serializes this final check with cancellation.
      await this.domain.table('runs').update(row.id, current => current)
      if (!allowed() || this.record(row.id).cancelRequestedAt !== null) return
      this.authorize?.(publicRun(row))
      const recovered = await this.tools.recover(row, harness)
      if (this.tools.retryAt(row.id) !== null) { await this.setRetry(row.id); return }
      const events = await this.readSession(harness.session)
      const consumed = events.some(event => event.type === 'user/message')
      const queued = [...harness.inbox.nextTurn, ...harness.inbox.nextStep]
      const text = consumed ? `Continue the accepted task from its saved history. Do not repeat completed operations.${recovered.length === 0 ? '' : ` Recovered tool results: ${recovered.join('\n')}`}` : row.input.prompt
      const message = queued[0] ?? freezeMessage({ role: 'user', id: brandString<MessageId>(consumed ? `${row.id}:resume:${reliableRun(row).runtime.attempt}` : `${row.id}:input`),
        content: [{ type: 'text', text }], source: { kind: 'user' } })
      // Re-deliver a parked message by removing its durable queue entry first.
      if (queued[0] !== undefined) harness.inbox.remove(message.id)
      await this.domain.table('runs').update(row.id, current => transitionRun(current, 'RUNNING', new Date().toISOString(), { error: null }))
      if (!allowed() || this.record(row.id).cancelRequestedAt !== null) return
      harness.followup(message)
      const heartbeat = setInterval(() => {
        this.enqueue(row.id, () => this.checkpoint(row.id, reliableRun(row).runtime.attempt, harness.session))
      }, reliableRun(row).policy.checkpointMs)
      try { await harness.whenIdle() } finally { clearInterval(heartbeat) }
      await this.pending.get(row.id)
      await this.tools.drain(row.id)
      if (this.tools.retryAt(row.id) !== null) { await this.setRetry(row.id); return }
      await this.project(row.id, harness.session)
      await this.checkpoint(row.id, reliableRun(row).runtime.attempt, harness.session)
      if (this.record(row.id).cancelRequestedAt !== null && !isRunTerminal(this.record(row.id).status)) {
        await this.domain.table('runs').update(row.id, current => transitionRun(current, 'CANCELLED', new Date().toISOString()))
      }
    } catch (error) {
      if (this.closing) {
        await this.domain.table('runs').update(row.id, current => transitionRun(current, 'RECOVERING', new Date().toISOString()))
      } else if (error instanceof Error && 'code' in error && error.code === 'session/model-unavailable'
        && reliableRun(row).runtime.attempt < reliableRun(row).policy.maxAttempts) {
        await this.domain.table('runs').update(row.id, current => transitionRun(current, 'RETRY_WAIT', new Date().toISOString(), {
          error: { code: 'MODEL_UNAVAILABLE', message: error.message },
          runtime: { ...reliableRun(current).runtime,
            nextAttemptAt: new Date(Date.now() + reliableRun(row).policy.retryDelayMs
              * 2 ** (reliableRun(row).runtime.attempt - 1)).toISOString() },
        }))
      } else if (error instanceof GovernanceError) {
        await this.fail(row.id, 'AUTHORIZATION_REVOKED', 'Execution permission revoked')
      } else if (error instanceof RecoveryBlocked) {
        await this.domain.table('runs').update(row.id, current => transitionRun(current, 'BLOCKED', new Date().toISOString(), {
          error: { code: 'RECOVERY_BLOCKED', message: error.message },
        }))
      } else {
        // A projection write can fail after Harness has durably finished. Recover
        // that original outcome before classifying an infrastructure exception.
        await this.reconcile(row.id)
        if (!isRunTerminal(this.record(row.id).status)) {
          await this.fail(row.id, 'EXECUTION_FAILED', error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  /** Request cancellation; execution completion, not the click, decides the terminal status.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param runId - task identity.
   * @returns persisted current state with cancellation intent.
   */
  async cancel(workspace: string, agentId: string, runId: string): Promise<PlatformRun> {
    const before = this.read(workspace, agentId, runId)
    const settled = this.ctx.agents.get(before.sessionId)
    if (settled?.status === 'idle' && !this.launching.has(runId)) await this.project(runId, settled.session)
    const current = await this.get(workspace, agentId, runId)
    if (isRunTerminal(current.status)) return current
    const row = await this.domain.table('runs').update(runId, (current) => {
      if (isRunTerminal(current.status)) return current
      const at = new Date().toISOString()
      const next = { ...current, cancelRequestedAt: current.cancelRequestedAt ?? at,
        events: current.cancelRequestedAt !== null ? current.events : [...current.events, {
          eventId: `${current.id}:${current.events.length}`, runId: current.id, agentId: current.agentId,
          agentVersionId: current.agentVersionId, sessionId: current.sessionId, type: 'run.cancel-requested' as const, occurredAt: at,
        }],
      }
      const live = this.ctx.agents.get(current.sessionId)
      return live?.status !== 'running' && !this.launching.has(runId) ? transitionRun(next, 'CANCELLED', at) : next
    })
    if (!isRunTerminal(row.status)) {
      const agent = this.ctx.agents.get(row.sessionId)
      if (agent === undefined) await this.reconcile(runId)
      else agent.cancel({ kind: 'user' })
    }
    return this.get(workspace, agentId, runId)
  }

  /** Persist an explicit external-outcome decision before scheduling recovery.
   * @param workspace - authorized workspace.
   * @param agentId - owning Agent.
   * @param runId - blocked task.
   * @param callId - unresolved top-level invocation.
   * @param decision - externally verified outcome.
   * @param evidence - operator's verification evidence.
   * @param token - idempotent resolution identity.
   * @returns current Run; this call does not execute the tool.
   */
  async resolve(workspace: string, agentId: string, runId: string, callId: string, decision: 'completed' | 'not-executed', evidence: string, token: string): Promise<PlatformRun> {
    this.read(workspace, agentId, runId)
    tokenSchema.parse(token)
    z.enum(['completed', 'not-executed']).parse(decision)
    z.string().trim().min(1).max(4000).parse(evidence)
    const invocation = this.tools.calls(runId).find(row => row.callId === callId)
    if (invocation === undefined || invocation.nested) throw new RegistryError('conflict', 'Select an unresolved top-level invocation')
    await this.domain.table('runs').update(runId, (row) => {
      const prior = row.runtime?.resolution
      if (prior?.token === token) {
        if (prior.callId !== callId || prior.decision !== decision || prior.evidence !== evidence) throw new RegistryError('conflict', 'Resolution token used for different evidence')
        return row
      }
      if (row.status !== 'BLOCKED' || row.cancelRequestedAt !== null || invocation.state !== 'DISPATCHING') throw new RegistryError('conflict', 'Run is not awaiting this external outcome')
      const at = new Date().toISOString()
      const decided = { ...row, events: [...row.events, { eventId: `${row.id}:${row.events.length}`, runId: row.id,
        agentId: row.agentId, agentVersionId: row.agentVersionId, sessionId: row.sessionId, type: 'run.resolved' as const, occurredAt: at,
        actorId: platformActor(), interventionId: row.events.findLast(event => event.type === 'run.blocked')?.eventId,
        decision }] }
      return transitionRun(decided, 'RECOVERING', at, { error: null,
        runtime: { ...reliableRun(row).runtime, resolution: { token, callId, decision, evidence, at } },
      })
    })
    return this.get(workspace, agentId, runId)
  }
}
