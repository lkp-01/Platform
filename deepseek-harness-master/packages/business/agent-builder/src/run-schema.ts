/** Compatible storage decoding for legacy admissions and current Run records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentVersionId, PlatformRunId, RegistryAgentId } from './types.ts'
import { runtimePolicySchema } from './runtime-policy.ts'
import { memoryContextSchema } from './memory-schema.ts'

/** Public lifecycle vocabulary, also validated at the Remote boundary. */
export const runStatusSchema = z.enum(['PENDING', 'RUNNING', 'RETRY_WAIT', 'RECOVERING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED'])
const runId = z.string().transform(value => brandString<PlatformRunId>(value))
const agentId = z.string().transform(value => brandString<RegistryAgentId>(value))
const versionId = z.string().transform(value => brandString<AgentVersionId>(value))
const sessionId = z.string().transform(value => brandString<SessionId>(value))
const date = z.iso.datetime().nullable().default(null)
const legacyStatus = z.enum(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']).transform((value) => {
  const map = { accepted: 'PENDING', running: 'RUNNING', succeeded: 'SUCCEEDED', failed: 'FAILED', cancelled: 'CANCELLED', interrupted: 'FAILED' } as const
  return map[value]
})

/** Old rows retain format 1 until their Session facts have been reconciled. */
export const runSchema = z.object({
  id: runId, agentId, agentVersionId: versionId, versionNumber: z.number().int().positive(),
  platformWorkspaceId: z.string(), configHash: z.string(), deploymentRevision: z.number().int().positive(),
  ownerTeamIdAtStart: z.string().optional(),
  sessionId, createdAt: z.iso.datetime(), createdBy: z.string(),
  memoryContext: memoryContextSchema.optional(),
  status: z.union([runStatusSchema, legacyStatus]),
  error: z.union([z.object({ code: z.string(), message: z.string() }), z.string().transform(message => ({ code: 'LEGACY_ERROR', message }))]).nullable(),
  fingerprint: z.string(), format: z.number().int().min(1).max(3).default(1),
  policy: runtimePolicySchema.optional(),
  runtime: z.object({ attempt: z.number().int().nonnegative(), heartbeatAt: date,
    checkpointSeq: z.number().int().min(-1), checkpointAt: date, nextAttemptAt: date, deadlineAt: z.iso.datetime(),
    resolution: z.object({ token: z.string(), callId: z.string(), decision: z.enum(['completed', 'not-executed']), evidence: z.string(), at: z.iso.datetime() }).nullable().default(null),
  }).optional(),
  startedAt: date, finishedAt: date, cancelRequestedAt: date,
  finishTimeSource: z.enum(['execution', 'detected']).nullable().default(null),
  input: z.object({ prompt: z.string() }).nullable().default(null),
  result: z.object({ textPreview: z.string().nullable(), sessionId,
    finalMessageSeq: z.number().int().nonnegative().nullable() }).nullable().default(null),
  lastSessionSeq: z.number().int().default(-1),
  events: z.array(z.object({ eventId: z.string(), runId, agentId, agentVersionId: versionId, sessionId,
    type: z.enum(['run.created', 'run.started', 'run.succeeded', 'run.failed', 'run.cancelled',
      'run.recovering', 'run.retry-scheduled', 'run.blocked', 'run.cancel-requested', 'run.resolved']), occurredAt: z.iso.datetime(),
    actorId: z.string().optional(), interventionId: z.string().optional(), decision: z.enum(['completed', 'not-executed']).optional(),
  })).max(1024).default([]),
})

/** Internal persistence fields never accepted from API callers. */
export type RunRecord = z.infer<typeof runSchema>

/** Narrow a new admission before applying durable execution policies.
 * @param row - persisted compatible Run record.
 * @returns record with required reliability state; legacy rows cannot enter workers.
 */
export function reliableRun(row: RunRecord): RunRecord & {
  runtime: NonNullable<RunRecord['runtime']>
  policy: NonNullable<RunRecord['policy']>
} {
  if (row.runtime === undefined || row.policy === undefined) throw new Error('Legacy Run cannot enter a reliable worker')
  return { ...row, runtime: row.runtime, policy: row.policy }
}
