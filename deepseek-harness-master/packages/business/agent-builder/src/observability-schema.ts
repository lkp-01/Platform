/** Durable read models and validated public analytics filters. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { runStatusSchema } from './run-schema.ts'
import { priceSchema } from './observability-pricing.ts'
import type { AnalysisFact, ObservationQuery } from './observability-types.ts'

/** Validated classification vocabulary. */
export const errorCategorySchema = z.enum(['tool_timeout', 'tool_error', 'model_timeout', 'model_error', 'invalid_params',
  'rate_limited', 'permission_denied', 'runtime_error', 'unknown'])
const count = z.number().int().nonnegative()
const nullableText = z.string().nullable()
const date = z.iso.datetime()
/** Compatible durable decoding of compact Run analysis facts. */
export const analysisFactSchema = z.object({
  runId: z.string(), workspaceId: z.string(), agentId: z.string(), versionId: z.string(), versionNumber: count,
  ownerTeamId: nullableText.default(null), status: runStatusSchema, createdAt: date, finishedAt: date.nullable(),
  durationMs: count.nullable(), queueMs: count.nullable().default(null), errorCategory: errorCategorySchema.nullable().default(null),
  sourceRevision: z.string(), indexedAt: date, traceState: z.enum(['pending', 'complete', 'partial', 'unavailable']),
  usageComplete: z.boolean(), totalTokens: count.nullable(),
  attempts: z.array(z.object({ id: z.string(), operationId: z.string(), eventId: z.string(), kind: z.enum(['tool', 'model']),
    name: z.string(),
    resourceId: nullableText, resourceVersionId: nullableText, provider: nullableText, model: nullableText,
    startedAt: date.nullable(), finishedAt: date.nullable(), durationMs: count.nullable(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']), number: count,
    errorCategory: errorCategorySchema.nullable(), errorCode: nullableText,
    usage: z.object({ inputTokens: count.nullable(), outputTokens: count, totalTokens: count.nullable(),
      uncachedInputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() }).nullable(),
    cost: z.object({ priceVersion: z.string(), currency: z.string(), nanoUnits: z.string().regex(/^\d+$/), ruleVersion: count }).nullable(),
  })).default([]),
  interventions: z.array(z.object({ id: z.string(), requestedAt: date, endedAt: date.nullable(), resolved: z.boolean(),
    actorId: nullableText })).default([]),
  rejections: z.array(z.object({ eventId: z.string(), name: z.string(), category: errorCategorySchema })).default([]),
}) satisfies z.ZodType<AnalysisFact>

/** Wire validation bounds cohort windows and version filters. */
export const observationQuerySchema = z.strictObject({
  window: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('time'), from: date, to: date }).refine(
    value => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 30 * 86400000,
    'Time window must be positive and at most 30 days'), z.strictObject({ kind: z.literal('last'),
    count: z.number().int().min(1).max(1000) })]),
  agentId: z.string().min(1).max(200).optional(), versionId: z.string().min(1).max(200).optional(),
  compareVersionId: z.string().min(1).max(200).optional(), resourceKey: z.string().max(1000).optional(),
  errorCategory: errorCategorySchema.optional(), cohortMode: z.enum(['runs', 'attempts']).optional(),
  ownerTeamId: z.string().max(200).optional(),
}).refine(value => (!value.versionId && !value.compareVersionId) || !!value.agentId, 'Versions require an Agent')
  .refine(value => value.cohortMode !== 'attempts' || value.window.kind === 'time',
    'Attempt cohort requires a time window') satisfies z.ZodType<ObservationQuery>

/** Derived Run records; each publication is one atomic replacement. */
export const observabilitySpec = defineDomain({ name: 'platform_observability', version: 1, tables: {
  runs: domainTable<string, AnalysisFact>(analysisFactSchema),
  prices: domainTable(priceSchema),
} })
