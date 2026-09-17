import { expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { analysisFactSchema } from '../src/observability-schema.ts'
import { resourceMetrics, summarize } from '../src/observability-metrics.ts'

it('aggregates 10,000 runs and 100,000 attempts without transcript reads', () => {
  const base = analysisFactSchema.parse({ runId: 'r', workspaceId: 'w', agentId: 'a', versionId: 'v', versionNumber: 1,
    status: 'SUCCEEDED', createdAt: '2026-09-17T00:00:00Z', finishedAt: '2026-09-17T00:00:01Z', durationMs: 1000,
    sourceRevision: 'r', indexedAt: '2026-09-17T00:00:01Z', traceState: 'complete', usageComplete: true, totalTokens: 5000 })
  const rows = Array.from({ length: 10000 }, (_, i) => ({ ...base, runId: `r${i}`, agentId: `a${i % 50}`,
    attempts: Array.from({ length: 10 }, (_, j) => ({ id: `${i}:${j}`, operationId: `${i}:${j}`, eventId: `${i}:${j}`,
      kind: 'tool' as const, name: `tool-${j % 5}`, resourceId: null, resourceVersionId: null, provider: null, model: null,
      startedAt: base.createdAt, finishedAt: base.finishedAt, durationMs: 100, outcome: 'succeeded' as const,
      number: 1, errorCategory: null, errorCode: null, usage: null, cost: null })) }))
  const timings = Array.from({ length: 6 }, () => {
    const start = performance.now()
    expect(summarize(rows)).toMatchObject({ sampleCount: 10000, successRate: 1, tools: { count: 100000 } })
    expect(resourceMetrics(rows)).toHaveLength(5)
    return performance.now() - start
  }).slice(1).sort((a, b) => a - b)
  console.log(`Observability core aggregation: 10000 runs / 100000 attempts; warm P95 ${timings.at(-1)!.toFixed(1)}ms`)
  expect(timings.at(-1)).toBeLessThan(1000)
})
