import { describe, expect, it } from 'vitest'
import { classifyError } from '../src/observability-errors.ts'
import { priceAttempt, validatePrices } from '../src/observability-pricing.ts'
import { summarize } from '../src/observability-metrics.ts'
import { analysisFactSchema } from '../src/observability-schema.ts'

const at = '2026-09-17T00:00:00.000Z'
const fact = (status = 'SUCCEEDED') => analysisFactSchema.parse({ runId: status, workspaceId: 'w', agentId: 'a',
  versionId: 'v1', versionNumber: 1, status, createdAt: at, finishedAt: at, durationMs: 1000,
  sourceRevision: 'r', indexedAt: at, traceState: 'complete', usageComplete: true, totalTokens: 0 })

describe('Agent analysis accounting', () => {
  it('separates cancellations, unknown measurements and task failures', () => {
    const rows = [...Array.from({ length: 920 }, () => fact()), ...Array.from({ length: 80 }, () => fact('FAILED')),
      ...Array.from({ length: 20 }, () => fact('CANCELLED'))]
    const result = summarize(rows)
    expect(result).toMatchObject({ sampleCount: 1020, succeeded: 920, failed: 80, cancelled: 20, successRate: 0.92 })
    expect(summarize([]).successRate).toBeNull()
    expect(summarize([{ ...fact(), usageComplete: false, totalTokens: null }]).tokens.average).toBeNull()
  })
  it('counts attempts independently of logical calls and ignores scheduled-only retries', () => {
    const row = fact()
    row.attempts = [
      { id: 't:1', operationId: 't', eventId: 'e1', kind: 'tool', name: 'search', resourceId: null, resourceVersionId: null,
        provider: null, model: null, startedAt: at, finishedAt: at, durationMs: 10, outcome: 'failed', errorCategory: 'tool_timeout',
        errorCode: 'ETIMEDOUT', usage: null, cost: null, number: 1 },
      { id: 't:2', operationId: 't', eventId: 'e2', kind: 'tool', name: 'search', resourceId: null, resourceVersionId: null,
        provider: null, model: null, startedAt: at, finishedAt: at, durationMs: 20, outcome: 'succeeded', errorCategory: null,
        errorCode: null, usage: null, cost: null, number: 2 },
    ]
    const result = summarize([row])
    expect(result.successRate).toBe(1)
    expect(result.tools).toMatchObject({ successRate: 0.5, logicalSuccessRate: 1, timeoutRate: 0.5, retries: 1 })
    expect(summarize([fact()]).tools.retries).toBe(0)
  })
  it('classifies explicit codes without guessing from error prose', () => {
    expect(classifyError('ETIMEDOUT', 'tool')).toBe('tool_timeout')
    expect(classifyError('ETIMEDOUT', 'model')).toBe('model_timeout')
    expect(classifyError('A timeout happened', 'tool')).toBe('unknown')
    expect(classifyError('INVALID_PARAMS', 'tool')).toBe('invalid_params')
  })
  it('prices cache categories once with a versioned fixed-point rule', () => {
    const prices = validatePrices([{ id: 'p1', provider: 'p', model: 'm', currency: 'USD', effectiveFrom: at,
      effectiveTo: null, input: 2000000, cacheRead: 1000000, cacheWrite: 3000000, output: 4000000 }])
    expect(priceAttempt(prices, 'p', 'm', at, { inputTokens: 30, outputTokens: 5, totalTokens: 35,
      uncachedInputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10 })).toEqual({
      priceVersion: 'p1', currency: 'USD', nanoUnits: '80000', ruleVersion: 1,
    })
    expect(priceAttempt(prices, 'p', 'm', at, { inputTokens: 30, outputTokens: 5, totalTokens: 35 })).toBeNull()
    expect(() => validatePrices([...prices, { ...prices[0]!, id: 'p2' }])).toThrow()
  })
})
