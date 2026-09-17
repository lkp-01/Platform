/** Single-Host derived analytics, isolated from task execution. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { PlatformRuns } from './platform-runs.ts'
import type { PlatformTraces } from './platform-traces.ts'
import type { AgentVersions } from './versions.ts'
import type { AnalysisFact, ModelPrice, ObservationQuery, ObservationReport, ObservationRunPage } from './observability-types.ts'
import { observabilitySpec, observationQuerySchema } from './observability-schema.ts'
import { projectAnalysis } from './observability-projection.ts'
import { resourceKey, resourceMetrics, summarize } from './observability-metrics.ts'
import { isRunTerminal } from './run-lifecycle.ts'
import { RegistryError } from './registry.ts'
import { validatePrices } from './observability-pricing.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const cursorSchema = z.object({ revision: z.string(), filter: z.string(), offset: z.number().int().nonnegative() })

/** Atomic per-Run replacement avoids cross-table partial generations. */
export class PlatformObservability {
  private readonly dirty = new Set<string>()
  private readonly rebuild = new Set<string>()
  private readonly failures = new Set<string>()
  private readonly byWorkspace = new Map<string, Map<string, AnalysisFact>>()
  private readonly unlisten: (() => void)[] = []
  private pending: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closing = false
  private constructor(private readonly ctx: Context, private readonly runs: PlatformRuns, private readonly traces: PlatformTraces,
    private readonly versions: AgentVersions, private readonly domain: Domain<typeof observabilitySpec>,
    private readonly prices: ModelPrice[],
    private readonly refreshMs: number) {}

  /** Start bounded sequential backfill and notifications without blocking Agent admission.
   * @param ctx - existing plugin context.
   * @param runs - lifecycle authority.
   * @param traces - shared structured event reader.
   * @param versions - immutable resource attribution.
   * @param prices - validated operator rate versions.
   * @param refreshMs - background reconciliation interval.
   * @returns disposable analytics service.
   */
  static async open(ctx: Context, runs: PlatformRuns, traces: PlatformTraces, versions: AgentVersions,
    prices: ModelPrice[], refreshMs: number): Promise<PlatformObservability> {
    const domain = await ctx.storageDomain.open(observabilitySpec)
    let persistedPrices: ModelPrice[]
    try {
      const stored = new Map(domain.table('prices').entries())
      for (const price of prices) {
        const prior = stored.get(price.id)
        if (prior !== undefined && hash(prior) !== hash(price)) throw new Error(`Model price version ${price.id} is immutable`)
        stored.set(price.id, price)
      }
      persistedPrices = validatePrices([...stored.values()])
      for (const price of prices) {
        if (domain.table('prices').get(price.id) === undefined) await domain.table('prices').put(price.id, price)
      }
    } catch (error) { await domain.close(); throw error }
    const service = new PlatformObservability(ctx, runs, traces, versions, domain, persistedPrices, refreshMs)
    for (const [, row] of service.domain.table('runs').entries()) service.publish(row)
    for (const run of runs.analysisRuns()) { service.dirty.add(run.id); service.rebuild.add(run.id) }
    service.unlisten.push(ctx.on('domain/changed', (change) => {
      if (change.operation !== 'put') return
      if (change.domain === 'platform_agent_runs') service.dirty.add((change.value as { id: string }).id)
      if (change.domain === 'platform_run_traces' && change.table === 'summaries') service.dirty.add((change.value as { runId: string }).runId)
    }))
    service.tick()
    return service
  }

  private publish(row: AnalysisFact): void {
    const workspace = this.byWorkspace.get(row.workspaceId) ?? new Map<string, AnalysisFact>()
    workspace.set(row.runId, row); this.byWorkspace.set(row.workspaceId, workspace)
  }

  private tick(): void {
    this.timer = setTimeout(() => {
      void this.flush().catch((error: unknown) => { this.ctx.logger.error('Observability reconciliation failed: %s', String(error)) })
        .finally(() => { if (!this.closing) this.tick() })
    }, this.refreshMs)
    this.timer.unref()
  }

  /** Reconcile queued facts; failure remains visible and retries on the next cycle. */
  async flush(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    this.pending = this.drain().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async drain(): Promise<void> {
    const sources = new Map(this.runs.analysisRuns().map(run => [run.id as string, run]))
    for (const id of this.failures) this.dirty.add(id)
    const batch = [...this.dirty]
    for (const id of batch) {
      this.dirty.delete(id)
      const source = sources.get(id)
      if (source === undefined) continue
      try {
        const run = await this.runs.get(source.platformWorkspaceId, source.agentId, source.id)
        const { trace, items } = await this.traces.snapshot(run, this.rebuild.has(id))
        const manifest = this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId).snapshot.resources
        const row = projectAnalysis(run, trace, items, manifest, this.prices, new Date().toISOString())
        const prior = this.domain.table('runs').get(id)
        // An already applied immutable price version survives config reload and rebuilding.
        const oldAttempts = new Map(prior?.attempts.map(attempt => [attempt.id, attempt]) ?? [])
        for (const attempt of row.attempts) {
          const old = oldAttempts.get(attempt.id)
          if (old?.cost && JSON.stringify(old.usage) === JSON.stringify(attempt.usage)
            && old.provider === attempt.provider && old.model === attempt.model
            && old.startedAt === attempt.startedAt) attempt.cost = old.cost
        }
        if (prior === undefined || hash({ ...prior, indexedAt: '' }) !== hash({ ...row, indexedAt: '' })) {
          await this.domain.table('runs').put(id, row)
          this.publish(row)
        }
        this.failures.delete(id); this.rebuild.delete(id)
      } catch (error) {
        this.failures.add(id)
        this.ctx.logger.error('Observability projection failed for %s: %s', id, String(error))
      }
    }
  }

  private select(rows: AnalysisFact[], query: ObservationQuery): AnalysisFact[] {
    const window = query.window
    let result = rows.filter(row => (!query.agentId || row.agentId === query.agentId)
      && (!query.versionId || row.versionId === query.versionId)
      && (!query.ownerTeamId || row.ownerTeamId === query.ownerTeamId))
    if (query.cohortMode === 'attempts' && window.kind === 'time') {
      result = result.map(row => ({ ...row, attempts: row.attempts.filter(attempt => attempt.finishedAt !== null
        && Date.parse(attempt.finishedAt) >= Date.parse(window.from)
        && Date.parse(attempt.finishedAt) < Date.parse(window.to)) })).filter(row => row.attempts.length > 0)
    } else {
      result = result.filter((row): row is AnalysisFact & { finishedAt: string } => isRunTerminal(row.status) && row.finishedAt !== null && (window.kind === 'last'
        || Date.parse(row.finishedAt) >= Date.parse(window.from) && Date.parse(row.finishedAt) < Date.parse(window.to)))
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || b.runId.localeCompare(a.runId))
      if (window.kind === 'last') result = result.slice(0, window.count)
    }
    if (query.resourceKey) result = result.map(row => ({ ...row,
      attempts: row.attempts.filter(attempt => resourceKey(attempt) === query.resourceKey) }))
      .filter(row => row.attempts.length > 0)
    if (query.errorCategory) result = query.resourceKey || query.cohortMode === 'attempts'
      ? result.filter(row => row.attempts.some(attempt => attempt.errorCategory === query.errorCategory))
      : result.filter(row => row.errorCategory === query.errorCategory && row.status === 'FAILED')
    if (query.cohortMode === 'attempts' || query.resourceKey) result = result.map((row) => {
      const models = row.attempts.filter(attempt => attempt.kind === 'model')
      const totals = models.flatMap(attempt => attempt.usage?.totalTokens == null ? [] : [attempt.usage.totalTokens])
      return { ...row, usageComplete: totals.length === models.length,
        totalTokens: models.length > 0 && totals.length === 0 ? null : totals.reduce((sum, value) => sum + value, 0) }
    })
    return result
  }

  private snapshot(workspace: string,
    input: ObservationQuery): { rows: AnalysisFact[]; all: AnalysisFact[]; query: ObservationQuery; revision: string } {
    const query = observationQuerySchema.parse(input)
    const all = [...this.byWorkspace.get(workspace)?.values() ?? []]
    const revision = hash(all.map(row => [row.runId, row.indexedAt, row.sourceRevision]))
    return { rows: this.select(all, query), all, query, revision }
  }

  /** Query already published facts without reading Session transcripts.
   * @param workspace - authorized organization scope.
   * @param input - validated time or last-N filters.
   * @returns coverage, distributions, dependencies and version comparison.
   */
  query(workspace: string, input: ObservationQuery): ObservationReport {
    const { rows, all, query, revision } = this.snapshot(workspace, input)
    const sources = this.runs.analysisRuns().filter(row => row.platformWorkspaceId === workspace
      && (!query.agentId || row.agentId === query.agentId))
    const indexed = all.filter(row => !query.agentId || row.agentId === query.agentId)
    const missing = sources.filter(row => this.failures.has(row.id) || this.dirty.has(row.id) || this.rebuild.has(row.id)
      || !this.byWorkspace.get(workspace)?.has(row.id))
    const comparison = query.compareVersionId ? this.select(all, { ...query, versionId: query.compareVersionId }) : null
    const agents = new Map<string, AnalysisFact[]>(), days = new Map<string, AnalysisFact[]>()
    for (const row of rows) {
      const group = agents.get(row.agentId) ?? []; group.push(row); agents.set(row.agentId, group)
      const day = row.finishedAt?.slice(0, 10)
      if (day) { const bucket = days.get(day) ?? []; bucket.push(row); days.set(day, bucket) }
    }
    const active = (['PENDING', 'RUNNING', 'RETRY_WAIT', 'RECOVERING', 'BLOCKED'] as const).map((status) => {
      const matching = sources.filter(row => row.status === status)
      return { status, count: matching.length, oldestCreatedAt: matching.map(row => row.createdAt).sort()[0] ?? null }
    })
    const partial = rows.some(row => row.traceState === 'partial' || row.traceState === 'unavailable')
    return { revision, asOf: new Date().toISOString(), dataState: missing.length || partial ? 'partial' : 'complete',
      indexedRunCount: indexed.length, eligibleRunCount: sources.length,
      lagMs: missing.length ? Math.max(0, Date.now() - Math.min(...missing.map(row => Date.parse(row.finishedAt ?? row.createdAt)))) : 0,
      missingReasons: [...(missing.length ? ['projection_pending'] : []), ...(partial ? ['trace_partial'] : [])],
      summary: summarize(rows),
      comparison: comparison === null || query.compareVersionId === undefined ? null : { versionId: query.compareVersionId,
        summary: summarize(comparison), lowSample: comparison.length < 30 || rows.length < 30 },
      agents: [...agents].map(([agentId, group]) => ({ agentId, summary: summarize(group) })).sort((a,
        b) => b.summary.failed - a.summary.failed),
      resources: resourceMetrics(rows), trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date,
        group]) => ({ date, summary: summarize(group) })),
      active, unknownTimeCount: indexed.filter(row => isRunTerminal(row.status) && row.finishedAt === null).length }
  }

  /** Page a stable cohort, rejecting stale and cross-filter cursors.
   * @param workspace - authorized scope.
   * @param input - same filters as the report.
   * @param cursor - opaque revision-bound offset.
   * @param limit - bounded page size.
   * @returns privacy-minimal Run links.
   */
  page(workspace: string, input: ObservationQuery, cursor?: string, limit = 50): ObservationRunPage {
    z.number().int().min(1).max(100).parse(limit)
    const { rows, query, revision } = this.snapshot(workspace, input)
    const filter = hash([workspace, query])
    let offset = 0
    if (cursor !== undefined) {
      z.string().max(2048).parse(cursor)
      let decoded: z.infer<typeof cursorSchema>
      try { decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) }
      catch { throw new RegistryError('conflict', 'Invalid analysis cursor') }
      if (decoded.revision !== revision || decoded.filter !== filter || decoded.offset > rows.length) throw new RegistryError('conflict', 'Analysis changed; refresh the report')
      offset = decoded.offset
    }
    return { revision, items: rows.slice(offset, offset + limit).map(row => ({ runId: row.runId, agentId: row.agentId,
      versionId: row.versionId, status: row.status, finishedAt: row.finishedAt })),
    nextCursor: offset + limit < rows.length ? Buffer.from(JSON.stringify({ revision, filter,
      offset: offset + limit })).toString('base64url') : null }
  }

  /** Drain after Runtime and Trace have stopped publishing facts. */
  async close(): Promise<void> {
    this.closing = true; clearTimeout(this.timer)
    for (const dispose of this.unlisten) dispose()
    try { await this.pending; await this.flush() }
    finally { await this.domain.close() }
  }
}
