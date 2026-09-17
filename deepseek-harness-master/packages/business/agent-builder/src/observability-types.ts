/** Cross-run analytics contracts. Measurements retain missing values and their denominators. */
import type { TraceUsage } from './trace-types.ts'
import type { RunStatus } from './types.ts'

/** Mutually exclusive classifications from recorded adapter codes. */
export type ErrorCategory = 'tool_timeout' | 'tool_error' | 'model_timeout' | 'model_error' | 'invalid_params'
  | 'rate_limited' | 'permission_denied' | 'runtime_error' | 'unknown'
/** Rates are integer micro currency units per million tokens. */
export interface ModelPrice {
  id: string
  provider: string
  model: string
  currency: string
  effectiveFrom: string
  effectiveTo: string | null
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}
/** Decimal integer serialization avoids floating-point accumulation. */
export interface EstimatedCost { priceVersion: string
  currency: string
  nanoUnits: string
  ruleVersion: number }
/** One actual dispatch with its independent outcome and usage. */
export interface AnalysisAttempt {
  id: string
  operationId: string
  eventId: string
  kind: 'tool' | 'model'
  name: string
  resourceId: string | null
  resourceVersionId: string | null
  provider: string | null
  model: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  number: number
  errorCategory: ErrorCategory | null
  errorCode: string | null
  usage: TraceUsage | null
  cost: EstimatedCost | null
}
/** One requested operator decision, including unresolved waiting. */
export interface AnalysisIntervention {
  id: string
  requestedAt: string
  endedAt: string | null
  resolved: boolean
  actorId: string | null
}
/** One atomically replaced derived record
  contains no prompts, arguments or model output. */
export interface AnalysisFact {
  runId: string
  workspaceId: string
  agentId: string
  versionId: string
  versionNumber: number
  ownerTeamId: string | null
  status: RunStatus
  createdAt: string
  finishedAt: string | null
  durationMs: number | null
  queueMs: number | null
  errorCategory: ErrorCategory | null
  sourceRevision: string
  indexedAt: string
  traceState: 'pending' | 'complete' | 'partial' | 'unavailable'
  usageComplete: boolean
  totalTokens: number | null
  attempts: AnalysisAttempt[]
  interventions: AnalysisIntervention[]
  rejections: { eventId: string
    name: string
    category: ErrorCategory }[]
}
/** Explicit sample window and optional filters
  absent values do not imply global permission. */
export interface ObservationQuery {
  window: { kind: 'time'
    from: string
    to: string } | { kind: 'last'
      count: number }
  agentId?: string | undefined
  versionId?: string | undefined
  compareVersionId?: string | undefined
  resourceKey?: string | undefined
  errorCategory?: ErrorCategory | undefined
  cohortMode?: 'runs' | 'attempts' | undefined
  ownerTeamId?: string | undefined
}
/** Known observations and coverage with nearest-rank percentiles. */
export interface Measurement { average: number | null
  p50: number | null
  p95: number | null
  validCount: number
  unknownCount: number }
/** Actual-attempt rates alongside final logical-operation outcomes. */
export interface CallMetrics {
  count: number
  succeeded: number
  failed: number
  unknown: number
  cancelled: number
  successRate: number | null
  timeoutRate: number | null
  logicalSuccessRate: number | null
  retries: number
  latency: Measurement
}
/** Run-cohort metrics with separate cancellations, missing observations and currencies. */
export interface AnalysisSummary {
  sampleCount: number
  succeeded: number
  failed: number
  cancelled: number
  successRate: number | null
  cancellationRate: number | null
  latency: Measurement
  queue: Measurement
  tokens: { recorded: number | null
    average: number | null
    validCount: number
    unknownCount: number }
  tools: CallMetrics
  models: CallMetrics
  retryRuns: number
  interventionRuns: number
  resolvedInterventions: number
  interventionWait: Measurement
  errors: { category: ErrorCategory
    count: number }[]
  costs: { currency: string
    nanoUnits: string
    pricedCalls: number
    averagePerCall: number
    averagePerRun: number }[]
  unpricedCalls: number
  rejectedCalls: number
}
/** Observed dependency use and failed-attempt impact, scoped to the query cohort. */
export interface ResourceMetrics {
  key: string
  name: string
  kind: 'tool' | 'model'
  resourceId: string | null
  resourceVersionId: string | null
  calls: CallMetrics
  affectedAgents: number
  affectedRuns: number
  agentCount: number
  recordedTokens: number | null
  errors: { category: ErrorCategory
    count: number }[]
  costs: AnalysisSummary['costs']
  unpricedCalls: number
}
/** Published analysis snapshot, coverage and current Runtime backlog. */
export interface ObservationReport {
  revision: string
  asOf: string
  dataState: 'complete' | 'partial'
  indexedRunCount: number
  eligibleRunCount: number
  lagMs: number
  missingReasons: string[]
  summary: AnalysisSummary
  comparison: { versionId: string
    summary: AnalysisSummary
    lowSample: boolean } | null
  agents: { agentId: string
    summary: AnalysisSummary }[]
  resources: ResourceMetrics[]
  trend: { date: string
    summary: AnalysisSummary }[]
  active: { status: RunStatus
    count: number
    oldestCreatedAt: string | null }[]
  unknownTimeCount: number
}
/** Revision-bound links to the original Run and Trace. */
export interface ObservationRunPage {
  revision: string
  items: { runId: string
    agentId: string
    versionId: string
    status: RunStatus
    finishedAt: string | null }[]
  nextCursor: string | null
}
