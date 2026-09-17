/** Validated, snapshotted budgets for the single-Host task runtime. */
import { z } from 'zod'

/** Explicit deployment policy; persisted with each newly accepted Run. */
export const runtimePolicySchema = z.object({
  concurrency: z.number().int().min(1).max(64).default(4),
  pollMs: z.number().int().min(20).max(60000).default(1000),
  checkpointMs: z.number().int().min(100).max(60000).default(5000),
  maxAttempts: z.number().int().min(1).max(100).default(5),
  deadlineMs: z.number().int().min(1000).max(604800000).default(86400000),
  toolAttempts: z.number().int().min(1).max(10).default(3),
  retryDelayMs: z.number().int().min(1).max(60000).default(1000),
  maxToolCalls: z.number().int().min(1).max(100000).default(10000),
  maxToolResultBytes: z.number().int().min(1024).max(16777216).default(1048576),
  /** Host declarations must reflect the adapter's actual side-effect semantics. */
  replaySafeTools: z.array(z.string().min(1)).default([]),
  retryableToolCodes: z.array(z.string().min(1)).default(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']),
})

/** Fully resolved policy used by the scheduler and captured on admission. */
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>
