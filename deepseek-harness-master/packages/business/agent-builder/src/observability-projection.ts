/** Pure, privacy-minimal projection shared by summaries and drill-down. */
import type { PlatformRun } from './types.ts'
import type { RunTrace, TraceEvent } from './trace-types.ts'
import type { ResourceManifest } from './resource-types.ts'
import type { AnalysisAttempt, AnalysisFact, ModelPrice } from './observability-types.ts'
import { classifyError } from './observability-errors.ts'
import { priceAttempt } from './observability-pricing.ts'

/** Fold a published Trace once; a repeated source produces identical facts.
 * @param run - authoritative lifecycle.
 * @param trace - published summary.
 * @param events - all rows from that same summary revision.
 * @param manifest - immutable version bindings, absent for legacy versions.
 * @param prices - validated operator rate versions.
 * @param indexedAt - publication time for data freshness.
 * @returns compact replaceable Run record without raw execution content.
 */
export function projectAnalysis(run: PlatformRun, trace: RunTrace, events: TraceEvent[], manifest: ResourceManifest | undefined,
  prices: ModelPrice[], indexedAt: string): AnalysisFact {
  const attempts = new Map<string, AnalysisAttempt>()
  const modelNumbers = new Map<string, number>()
  const rejections = new Map<string, AnalysisFact['rejections'][number]>()
  const starts = new Map(events.filter(event => event.type.endsWith('.started')).map(event => [event.attemptId ?? event.operationId, event]))
  for (const event of events) {
    if (!/^(model|tool)\.(call|retry)\.(completed|failed|cancelled)$/.test(event.type)) continue
    if (event.dispatched === false) {
      if (event.type === 'tool.call.failed') rejections.set(event.eventId, { eventId: event.eventId, name: event.tool ?? 'unknown', category: classifyError(event.error?.code ?? null, 'tool') })
      continue
    }
    const kind = event.type.startsWith('model.') ? 'model' : 'tool'
    const id = event.attemptId ?? event.operationId ?? event.eventId
    if (attempts.has(id)) continue
    const start = starts.get(id)
    const operationId = kind === 'model' && event.turn !== null && event.step !== null
      ? `${run.id}:model:${event.turn}:${event.step}` : event.operationId ?? id
    const number = event.attemptNumber ?? (kind === 'model' ? (modelNumbers.get(operationId) ?? 0) + 1 : 1)
    modelNumbers.set(operationId, number)
    const resource = kind === 'tool' ? manifest?.tools.find(row => row.spec.kind === 'tool' && row.spec.operation === event.tool)
      : manifest?.model.spec.kind === 'model' && manifest.model.spec.provider === event.provider && manifest.model.spec.model === event.model ? manifest.model : undefined
    const outcome = event.type.endsWith('.cancelled') ? 'cancelled' : event.type.endsWith('.failed') ? 'failed' : 'succeeded'
    const unknown = kind === 'tool' && event.incomplete
    attempts.set(id, { id, operationId, number, eventId: event.eventId, kind,
      name: kind === 'tool' ? event.tool ?? 'unknown' : `${event.provider ?? 'unknown'}/${event.model ?? 'unknown'}`,
      resourceId: resource?.resourceId ?? null, resourceVersionId: resource?.id ?? null,
      provider: event.provider, model: event.model, startedAt: start?.occurredAt ?? null, finishedAt: unknown ? null : event.occurredAt,
      durationMs: event.durationMs, outcome: unknown ? 'unknown' : outcome,
      errorCategory: outcome === 'failed' && !unknown ? classifyError(event.error?.code ?? null, kind) : null,
      errorCode: event.error?.code ?? null, usage: event.usage,
      cost: kind === 'model' ? priceAttempt(prices, event.provider, event.model, start?.occurredAt ?? null, event.usage) : null })
  }
  for (const [id, event] of starts) {
    if (id === null || event.dispatched === false || attempts.has(id) || !event.type.startsWith('model.') && !event.type.startsWith('tool.')) continue
    const kind = event.type.startsWith('model.') ? 'model' : 'tool'
    attempts.set(id, { id, operationId: event.operationId ?? id, eventId: event.eventId, kind,
      name: kind === 'tool' ? event.tool ?? 'unknown' : `${event.provider ?? 'unknown'}/${event.model ?? 'unknown'}`,
      resourceId: null, resourceVersionId: null, provider: event.provider, model: event.model, startedAt: event.occurredAt,
      finishedAt: null, durationMs: null, outcome: 'unknown', number: event.attemptNumber ?? 1,
      errorCategory: null, errorCode: null, usage: null, cost: null })
  }
  const interventions = run.events.filter(event => event.type === 'run.blocked').map((event) => {
    const resolved = run.events.find(row => row.type === 'run.resolved' && row.interventionId === event.eventId)
    return { id: event.eventId, requestedAt: event.occurredAt, endedAt: resolved?.occurredAt ?? run.finishedAt,
      resolved: resolved !== undefined, actorId: resolved?.actorId ?? null }
  })
  const finishedAt = run.finishTimeSource === 'execution' ? run.finishedAt : null
  const duration = finishedAt !== null && run.startedAt !== null ? Date.parse(finishedAt) - Date.parse(run.startedAt) : null
  return { runId: run.id, workspaceId: run.platformWorkspaceId, agentId: run.agentId, versionId: run.agentVersionId,
    versionNumber: run.versionNumber, ownerTeamId: run.ownerTeamIdAtStart ?? null, status: run.status, createdAt: run.createdAt,
    finishedAt, durationMs: duration !== null && duration >= 0 ? duration : null,
    queueMs: run.startedAt === null ? null : Math.max(0, Date.parse(run.startedAt) - Date.parse(run.createdAt)),
    errorCategory: run.status === 'FAILED' ? classifyError(run.error?.code ?? null, 'runtime') : null,
    sourceRevision: trace.revision, indexedAt, traceState: trace.state,
    usageComplete: trace.usageComplete || trace.state === 'complete' && trace.modelCalls === 0,
    totalTokens: trace.modelCalls === 0 && trace.state === 'complete' ? 0 : trace.totalTokens,
    attempts: [...attempts.values()], interventions, rejections: [...rejections.values()] }
}
