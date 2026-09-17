/** Run-scoped execution facts
    payload previews never contain the complete model stream. */
import type { PlatformRun, RunLifecycleEvent } from './types.ts'

/** Public event vocabulary for the first Run timeline. */
export type TraceEventType = RunLifecycleEvent['type'] | 'model.call.started' | 'model.call.completed'
  | 'model.call.failed' | 'model.call.cancelled' | 'model.retry.scheduled' | 'tool.call.started'
  | 'tool.call.completed' | 'tool.call.failed' | 'tool.retry.started' | 'tool.retry.completed' | 'tool.retry.failed' | 'final.answer'
  | 'human.intervention.requested' | 'human.intervention.resolved' | 'memory.retrieve' | 'memory.extract' | 'memory.write'

/** Bounded, sanitized text with explicit loss information. */
export interface TracePreview { text: string
  truncated: boolean
  redacted: boolean }

/** Provider accounting for one attempt
    input includes cache tokens when an exact total is available. */
export interface TraceUsage {
  inputTokens: number | null
  outputTokens: number
  totalTokens: number | null
  uncachedInputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

/** One immutable timeline fact, linked to either a Session event or a platform observation. */
export interface TraceEvent {
  eventId: string
  type: TraceEventType
  occurredAt: string
  sourceSeq: number | null
  sourceRunEventId: string | null
  operationId: string | null
  attemptId?: string | undefined
  attemptNumber?: number | undefined
  actorId?: string | undefined
  interventionId?: string | undefined
  dispatched?: boolean | undefined
  turn: number | null
  step: number | null
  provider: string | null
  model: string | null
  tool: string | null
  /** Immutable workspace resource attribution, absent for unmanaged tools. */
  toolResourceId?: string | undefined
  toolVersionId?: string | undefined
  mcpServerId?: string | undefined
  mcpServerVersionId?: string | undefined
  /** Memory attribution; no Memory content or namespace subject is retained in Trace. */
  memoryStoreId?: string | undefined
  memoryScope?: 'session' | 'user' | 'agent' | undefined
  resultCount?: number | undefined
  memoryStatus?: 'succeeded' | 'failed' | 'degraded' | undefined
  durationMs: number | null
  preview: TracePreview | null
  usage: TraceUsage | null
  error: { code: string
    message: string } | null
  /** Interrupted repair, missing call start, or an unpaired result. */
  incomplete: boolean
}

/** Persisted platform observation of an actual model attempt opening. */
export interface TraceModelStart {
  id: string
  runId: PlatformRun['id']
  afterSeq: number
  occurredAt: string
  turn: number
  step: number
  provider: string | null
  model: string | null
}

/** Summary and attribution shared by every page of a Run trace. */
export interface RunTrace {
  runId: PlatformRun['id']
  sessionId: PlatformRun['sessionId']
  agentId: PlatformRun['agentId']
  agentVersionId: PlatformRun['agentVersionId']
  platformWorkspaceId: string
  revision: string
  state: 'pending' | 'complete' | 'partial' | 'unavailable'
  eventCount: number
  modelCalls: number
  toolCalls: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  usageComplete: boolean
}

/** Stable source-ordered page. Cursor belongs exclusively to this Run and projection version. */
export interface RunTracePage { trace: RunTrace
  items: TraceEvent[]
  nextCursor: string | null }
