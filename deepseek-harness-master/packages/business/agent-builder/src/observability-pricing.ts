/** Operator-owned, immutable rate versions. Prices never come from model output. */
import { z } from 'zod'
import type { TraceUsage } from './trace-types.ts'
import type { EstimatedCost, ModelPrice } from './observability-types.ts'

const rate = z.number().int().nonnegative()
/** Immutable operator rate version, persisted separately from derived facts. */
export const priceSchema = z.strictObject({ id: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/), effectiveFrom: z.iso.datetime(), effectiveTo: z.iso.datetime().nullable(),
  input: rate, cacheRead: rate, cacheWrite: rate, output: rate })

/** Validate non-overlapping operator rate versions at plugin initialization.
 * @param input - configured price list.
 * @returns validated rate versions.
 */
export function validatePrices(input: unknown): ModelPrice[] {
  const rows = z.array(priceSchema).max(1000).parse(input)
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error('Duplicate Model price version')
    ids.add(row.id)
    if (row.effectiveTo !== null && Date.parse(row.effectiveTo) <= Date.parse(row.effectiveFrom)) throw new Error('Invalid Model price interval')
    for (const other of rows) if (row !== other && row.provider === other.provider && row.model === other.model
      && Date.parse(row.effectiveFrom) < (other.effectiveTo === null ? Infinity : Date.parse(other.effectiveTo))
      && Date.parse(other.effectiveFrom) < (row.effectiveTo === null ? Infinity : Date.parse(row.effectiveTo))) {
      throw new Error('Overlapping Model price intervals')
    }
  }
  return rows
}

/** Estimate a completed attempt using its actual opening time and complete usage.
 * @param prices - validated rate versions.
 * @param provider - observed provider.
 * @param model - observed model.
 * @param startedAt - actual opening time, never a recovery timestamp.
 * @param usage - original provider categories.
 * @returns fixed-point cost or unknown when any necessary fact is absent.
 */
export function priceAttempt(prices: ModelPrice[], provider: string | null, model: string | null,
  startedAt: string | null, usage: TraceUsage | null): EstimatedCost | null {
  if (startedAt === null || usage === null || usage.totalTokens === null || usage.uncachedInputTokens === undefined
    || usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined) return null
  if (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens !== usage.totalTokens) return null
  const price = prices.find(row => row.provider === provider && row.model === model
    && Date.parse(row.effectiveFrom) <= Date.parse(startedAt)
    && (row.effectiveTo === null || Date.parse(startedAt) < Date.parse(row.effectiveTo)))
  if (!price) return null
  const microMillionths = BigInt(usage.uncachedInputTokens) * BigInt(price.input) + BigInt(usage.cacheReadTokens) * BigInt(price.cacheRead)
    + BigInt(usage.cacheWriteTokens) * BigInt(price.cacheWrite) + BigInt(usage.outputTokens) * BigInt(price.output)
  return { priceVersion: price.id, currency: price.currency, nanoUnits: ((microMillionths + 500n) / 1000n).toString(), ruleVersion: 1 }
}
