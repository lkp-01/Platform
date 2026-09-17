/** Validated durable Trace facts and bounded query pages. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { runSchema } from './run-schema.ts'
import type { RunTrace, TraceEvent, TraceModelStart } from './trace-types.ts'

const text = z.string().nullable()
const count = z.number().int().nonnegative()
const usage = z.object({ inputTokens: count.nullable(), outputTokens: count, totalTokens: count.nullable(),
  uncachedInputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() })
const preview = z.object({ text: z.string(), truncated: z.boolean(), redacted: z.boolean() })
const event = z.object({
  eventId: z.string(), type: z.enum(['run.created', 'run.started', 'run.succeeded', 'run.failed', 'run.cancelled',
    'run.recovering', 'run.retry-scheduled', 'run.blocked', 'run.cancel-requested', 'run.resolved',
    'model.call.started', 'model.call.completed', 'model.call.failed', 'model.call.cancelled', 'model.retry.scheduled',
    'tool.call.started', 'tool.call.completed', 'tool.call.failed', 'tool.retry.started', 'tool.retry.completed', 'tool.retry.failed', 'final.answer',
    'human.intervention.requested', 'human.intervention.resolved']),
  occurredAt: z.iso.datetime(), sourceSeq: count.nullable(), sourceRunEventId: text, operationId: text,
  attemptId: z.string().optional(), attemptNumber: count.optional(), actorId: z.string().optional(), interventionId: z.string().optional(),
  dispatched: z.boolean().optional(),
  turn: count.nullable(), step: count.nullable(), provider: text, model: text, tool: text, durationMs: count.nullable(),
  toolResourceId: z.string().optional(), toolVersionId: z.string().optional(),
  mcpServerId: z.string().optional(), mcpServerVersionId: z.string().optional(),
  memoryStoreId: z.string().optional(), memoryScope: z.enum(['session', 'user', 'agent']).optional(),
  resultCount: count.optional(), memoryStatus: z.enum(['succeeded', 'failed', 'degraded']).optional(),
  preview: preview.nullable(), usage: usage.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(), incomplete: z.boolean(),
}) satisfies z.ZodType<TraceEvent>
const start = z.object({ id: z.string(), runId: runSchema.shape.id, afterSeq: z.number().int().min(-1),
  occurredAt: z.iso.datetime(), turn: count, step: count, provider: text, model: text }) satisfies z.ZodType<TraceModelStart>
const summary = z.object({ runId: runSchema.shape.id, sessionId: runSchema.shape.sessionId, agentId: runSchema.shape.agentId,
  agentVersionId: runSchema.shape.agentVersionId, platformWorkspaceId: z.string(), revision: z.string(),
  state: z.enum(['pending', 'complete', 'partial', 'unavailable']), eventCount: count, modelCalls: count, toolCalls: count,
  inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(), usageComplete: z.boolean(),
}) satisfies z.ZodType<RunTrace>

/** Pages are published only after their matching summary checkpoint is durable. */
export const traceSpec = defineDomain({ name: 'platform_run_traces', version: 1, tables: {
  starts: domainTable<string, TraceModelStart>(start),
  summaries: domainTable<string, RunTrace>(summary),
  pages: domainTable<string, TraceEvent[]>(z.array(event).max(100)),
} })
