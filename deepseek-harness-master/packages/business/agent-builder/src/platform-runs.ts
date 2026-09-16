/** Minimal task admission and attribution; Harness remains the execution owner. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { tokenSchema } from './definition.ts'
import { RegistryError, type AgentRegistry } from './registry.ts'
import { historyPage, type AgentVersions } from './versions.ts'
import type { AgentDeployments } from './deployments.ts'
import type { AgentHistoryPage, AgentVersion, AgentVersionId, PlatformRun, PlatformRunId, RegistryAgentId } from './types.ts'

const runSchema = z.object({
  id: z.string().transform(value => brandString<PlatformRunId>(value)),
  agentId: z.string().transform(value => brandString<RegistryAgentId>(value)),
  agentVersionId: z.string().transform(value => brandString<AgentVersionId>(value)), versionNumber: z.number().int().positive(),
  platformWorkspaceId: z.string(), configHash: z.string(), deploymentRevision: z.number().int().positive(),
  sessionId: z.string().transform(value => brandString<SessionId>(value)), createdAt: z.iso.datetime(), createdBy: z.string(),
  status: z.enum(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']), error: z.string().nullable(),
  fingerprint: z.string(),
})
const spec = defineDomain({ name: 'platform_agent_runs', version: 1, tables: { runs: domainTable<string, z.infer<typeof runSchema>>(runSchema) } })

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
  const { fingerprint: _fingerprint, ...run } = row
  return structuredClone(run)
}

/** Durable admissions with one new Session per task and no implicit resubmission. */
export class PlatformRuns {
  private readonly launching = new Set<string>()
  private constructor(private readonly ctx: Context, private readonly domain: Domain<typeof spec>, private readonly registry: AgentRegistry,
    private readonly versions: AgentVersions, private readonly deployments: AgentDeployments) {}
  /** Open task admission persistence.
   * @param ctx - injected Harness and storage services.
   * @param registry - resource authority and admission serialization.
   * @param versions - immutable snapshot authority.
   * @param deployments - default activation authority.
   * @returns task adapter.
   */
  static async open(ctx: Context, registry: AgentRegistry, versions: AgentVersions, deployments: AgentDeployments): Promise<PlatformRuns> {
    return new PlatformRuns(ctx, await ctx.storageDomain.open(spec), registry, versions, deployments)
  }
  /** Drain persistent admissions. */
  async close(): Promise<void> { await this.domain.close() }
  /** Identify platform-owned Sessions for admission and model guards.
   * @param sessionId - Harness Session identity.
   * @returns immutable attribution, or undefined for ordinary Sessions.
   */
  forSession(sessionId: string): PlatformRun | undefined {
    const row = [...this.domain.table('runs').entries()].find(([, run]) => run.sessionId === sessionId)?.[1]
    return row === undefined ? undefined : publicRun(row)
  }
  /** Check a creation is owned by the currently admitted task.
   * @param sessionId - proposed Harness Session identity.
   * @param preset - resolved composition ID.
   */
  assertCreation(sessionId: string, preset: string): void {
    const run = this.forSession(sessionId)
    if (run === undefined || run.agentVersionId !== preset || !this.launching.has(run.id)) {
      throw new RegistryError('conflict', 'Start versioned tasks from the Agent Run entry')
    }
  }
  /** Read task facts and derive completion from the original Harness transcript.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param runId - platform task identity.
   * @returns attribution with projected status.
   */
  async get(workspace: string, agentId: string, runId: string): Promise<PlatformRun> {
    this.registry.get(workspace, agentId)
    const row = this.domain.table('runs').get(runId)
    if (row === undefined || row.agentId !== agentId || row.platformWorkspaceId !== workspace) throw new RegistryError('not-found', 'Run not found')
    const run = publicRun(row)
    if (run.status === 'failed') return run
    try {
      using observed = await this.ctx.sessionQuery.observeSession(run.sessionId)
      const ended = observed.events.findLast(event => event.type === 'turn/end')
      const live = this.ctx.agents.get(run.sessionId)
      if (live?.status === 'running') run.status = 'running'
      else if (ended?.type === 'turn/end') {
        const reason = ended.data.reason
        run.status = reason.kind === 'completed' ? 'succeeded' : reason.kind === 'aborted' ? 'cancelled'
          : reason.kind === 'interrupted' ? 'interrupted' : 'failed'
        run.error = reason.kind === 'error' ? reason.error.message : null
      } else run.status = this.launching.has(run.id) ? 'accepted' : 'interrupted'
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      run.status = this.launching.has(run.id) ? 'accepted' : 'interrupted'
    }
    return run
  }
  /** List task attributions newest first, optionally filtered by version.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param cursor - page offset.
   * @param versionId - optional exact version filter.
   * @returns bounded task page.
   */
  async list(workspace: string, agentId: string, cursor: number, versionId?: string): Promise<AgentHistoryPage<PlatformRun>> {
    this.registry.get(workspace, agentId)
    const rows = [...this.domain.table('runs').entries()].map(([, row]) => row)
      .filter(row => row.agentId === agentId && row.platformWorkspaceId === workspace
        && (versionId === undefined || row.agentVersionId === versionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const page = historyPage(rows, cursor)
    return { nextCursor: page.nextCursor, items: await Promise.all(page.items.map(row => this.get(workspace, agentId, row.id))) }
  }
  /** Accept one task against the deployment observed inside its admission lock.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param prompt - task text.
   * @param token - retry identity, never resubmitted after acceptance.
   * @param prepare - exact-version validation and artifact preparation.
   * @returns the accepted task, including explicit launch failures.
   */
  async start(
    workspace: string, agentId: string, prompt: string, token: string, prepare: (version: AgentVersion) => Promise<void>,
  ): Promise<PlatformRun> {
    tokenSchema.parse(token); z.string().min(1).max(32000).refine(value => value.trim().length > 0).parse(prompt)
    return this.registry.exclusive(workspace, agentId, async () => {
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
      await prepare(version)
      const row: z.infer<typeof runSchema> = { id, agentId: agent.id, platformWorkspaceId: workspace, agentVersionId: version.id,
        versionNumber: version.versionNumber, configHash: version.configHash, deploymentRevision: deployment.revision,
        sessionId: brandString<SessionId>(`session-${id}`), createdAt: new Date().toISOString(), createdBy: 'shared-host', status: 'accepted', error: null, fingerprint }
      await this.domain.table('runs').put(id, row)
      this.launching.add(id)
      try {
        await this.ctx.sessionController.create({ sessionId: row.sessionId, agentPreset: version.id })
        const harness = this.ctx.agents.get(row.sessionId)
        if (harness === undefined) throw new Error('Harness did not create the accepted Session')
        harness.session.append('platform/run', { runId: id, agentId: agent.id, agentVersionId: version.id, platformWorkspaceId: workspace,
          configHash: version.configHash, deploymentRevision: deployment.revision })
        await this.ctx.sessions.flush(harness.session)
        harness.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      } catch (error) {
        await this.domain.table('runs').update(id, current => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : String(error) }))
      } finally { this.launching.delete(id) }
      return this.get(workspace, agentId, id)
    })
  }
}
