/** Shared metric denominators; no counter increments on event delivery. */
import type { AnalysisAttempt, AnalysisFact, AnalysisSummary, CallMetrics, ErrorCategory, Measurement,
  ResourceMetrics } from './observability-types.ts'

const ratio = (a: number, b: number) => b === 0 ? null : a / b

/** Compute exact nearest-rank percentiles from known observations.
 * @param values - samples, including explicit missing values.
 * @returns distribution with coverage.
 */
export function measurement(values: (number | null)[]): Measurement {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  return { average: ratio(known.reduce((a, b) => a + b, 0), known.length),
    p50: known[Math.ceil(known.length * 0.5) - 1] ?? null, p95: known[Math.ceil(known.length * 0.95) - 1] ?? null,
    validCount: known.length, unknownCount: values.length - known.length }
}

/** Aggregate attempts and final known logical outcomes separately.
 * @param rows - unique actual attempts.
 * @returns call metrics.
 */
export function callMetrics(rows: AnalysisAttempt[]): CallMetrics {
  const succeeded = rows.filter(row => row.outcome === 'succeeded').length
  const failed = rows.filter(row => row.outcome === 'failed').length
  const logical = new Map<string, AnalysisAttempt>()
  for (const row of rows) if ((logical.get(row.operationId)?.number ?? -1) < row.number) logical.set(row.operationId, row)
  const final = [...logical.values()].filter(row => row.outcome === 'succeeded' || row.outcome === 'failed')
  return { count: rows.length, succeeded, failed, cancelled: rows.filter(row => row.outcome === 'cancelled').length,
    unknown: rows.filter(row => row.outcome === 'unknown').length, successRate: ratio(succeeded, succeeded + failed),
    timeoutRate: ratio(rows.filter(row => row.errorCategory === 'tool_timeout' || row.errorCategory === 'model_timeout').length, succeeded + failed),
    logicalSuccessRate: ratio(final.filter(row => row.outcome === 'succeeded').length, final.length),
    retries: rows.filter(row => row.number > 1).length, latency: measurement(rows.map(row => row.durationMs)) }
}

function errors(categories: (ErrorCategory | null)[]): { category: ErrorCategory; count: number }[] {
  const counts = new Map<ErrorCategory, number>()
  for (const category of categories) if (category !== null) counts.set(category, (counts.get(category) ?? 0) + 1)
  return [...counts].map(([category, count]) => ({ category, count })).sort((a,
    b) => b.count - a.count || a.category.localeCompare(b.category))
}

function costs(rows: AnalysisFact[]): Pick<AnalysisSummary, 'costs' | 'unpricedCalls'> {
  const currencies = new Map<string, { amount: bigint; calls: number; runs: Set<string> }>()
  let unpricedCalls = 0
  for (const row of rows) for (const attempt of row.attempts.filter(value => value.kind === 'model')) {
    if (attempt.cost === null) { unpricedCalls++; continue }
    const value = currencies.get(attempt.cost.currency) ?? { amount: 0n, calls: 0, runs: new Set<string>() }
    value.amount += BigInt(attempt.cost.nanoUnits); value.calls++; value.runs.add(row.runId)
    currencies.set(attempt.cost.currency, value)
  }
  return { unpricedCalls, costs: [...currencies].map(([currency, value]) => ({ currency, nanoUnits: value.amount.toString(),
    pricedCalls: value.calls, averagePerCall: Number(value.amount) / 1e9 / value.calls,
    averagePerRun: Number(value.amount) / 1e9 / value.runs.size })) }
}

/** Summarize one explicitly selected Run cohort.
 * @param rows - compact Run facts, each at most once.
 * @returns task metrics with independent per-measurement coverage.
 */
export function summarize(rows: AnalysisFact[]): AnalysisSummary {
  const succeeded = rows.filter(row => row.status === 'SUCCEEDED').length
  const failed = rows.filter(row => row.status === 'FAILED').length
  const cancelled = rows.filter(row => row.status === 'CANCELLED').length
  const known = rows.flatMap(row => row.usageComplete && row.totalTokens !== null ? [row.totalTokens] : [])
  const recorded = rows.flatMap(row => row.totalTokens === null ? [] : [row.totalTokens])
  const attempts = rows.flatMap(row => row.attempts)
  const interventions = rows.flatMap(row => row.interventions)
  return { sampleCount: rows.length, succeeded, failed, cancelled, successRate: ratio(succeeded, succeeded + failed),
    cancellationRate: ratio(cancelled, succeeded + failed + cancelled), latency: measurement(rows.map(row => row.durationMs)),
    queue: measurement(rows.map(row => row.queueMs)),
    tokens: { recorded: recorded.length === 0 ? null : recorded.reduce((a, b) => a + b, 0),
      average: ratio(known.reduce((sum, value) => sum + value, 0), known.length), validCount: known.length,
      unknownCount: rows.length - known.length },
    tools: callMetrics(attempts.filter(row => row.kind === 'tool')), models: callMetrics(attempts.filter(row => row.kind === 'model')),
    retryRuns: rows.filter(row => row.attempts.some(attempt => attempt.number > 1)).length,
    interventionRuns: rows.filter(row => row.interventions.length > 0).length,
    resolvedInterventions: interventions.filter(row => row.resolved).length,
    interventionWait: measurement(interventions.map(row => row.endedAt === null ? null : Math.max(0,
      Date.parse(row.endedAt) - Date.parse(row.requestedAt)))),
    rejectedCalls: rows.reduce((sum, row) => sum + row.rejections.length, 0),
    errors: errors(rows.filter(row => row.status === 'FAILED').map(row => row.errorCategory ?? 'unknown')), ...costs(rows) }
}

/** Stable key retains provider identity and explicit resource version boundaries.
 * @param row - attempt attribution.
 * @returns opaque filter value for resource drill-down.
 */
export function resourceKey(row: AnalysisAttempt): string {
  return JSON.stringify([row.kind, row.resourceId, row.resourceVersionId, row.provider, row.model, row.name])
}

/** Group actual use, not declared resource dependencies.
 * @param rows - selected Run facts with selected attempts.
 * @returns dependency health and observed impact.
 */
export function resourceMetrics(rows: AnalysisFact[]): ResourceMetrics[] {
  const groups = new Map<string, Map<string, AnalysisFact>>()
  for (const row of rows) for (const attempt of row.attempts) {
    const key = resourceKey(attempt)
    const runs = groups.get(key) ?? new Map<string, AnalysisFact>()
    const run = runs.get(row.runId) ?? { ...row, attempts: [] }
    run.attempts.push(attempt); runs.set(row.runId, run); groups.set(key, runs)
  }
  return [...groups].map(([key, group]) => {
    const facts = [...group.values()], attempts = facts.flatMap(row => row.attempts), first = attempts[0]
    if (first === undefined) throw new Error('Resource group requires an observed attempt')
    const affected = facts.filter(row => row.attempts.some(attempt => attempt.outcome === 'failed'))
    const tokens = attempts.flatMap(row => row.usage?.totalTokens == null ? [] : [row.usage.totalTokens])
    return { key, name: first.name, kind: first.kind, resourceId: first.resourceId, resourceVersionId: first.resourceVersionId,
      calls: callMetrics(attempts), affectedAgents: new Set(affected.map(row => row.agentId)).size, affectedRuns: affected.length,
      agentCount: new Set(facts.map(row => row.agentId)).size, recordedTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null,
      errors: errors(attempts.filter(row => row.outcome === 'failed').map(row => row.errorCategory ?? 'unknown')), ...costs(facts) }
  }).sort((a, b) => b.calls.failed - a.calls.failed || a.key.localeCompare(b.key))
}
