import { expect, it } from 'vitest'
import { runSchema } from '../src/run-schema.ts'
import { projectTrace } from '../src/trace-projection.ts'
import { projectAnalysis } from '../src/observability-projection.ts'
import { summarize, resourceMetrics } from '../src/observability-metrics.ts'
import type { PlatformRuns } from '../src/platform-runs.ts'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'

const at = '2026-09-17T00:00:00.000Z'
const run = runSchema.parse({ id: 'run-a', agentId: 'agent-a', agentVersionId: 'v1', versionNumber: 1,
  platformWorkspaceId: 'shared', configHash: 'hash', deploymentRevision: 1, sessionId: 's', createdAt: at, startedAt: at,
  finishedAt: '2026-09-17T00:00:02.000Z', finishTimeSource: 'execution', createdBy: 'user', status: 'SUCCEEDED', error: null, fingerprint: 'x' })
const calls: ReturnType<PlatformRuns['toolHistory']> = [{ id: 'run-a:call', runId: 'run-a', callId: 'call', name: 'search',
  arguments: '{"secret":"do not persist"}', state: 'DONE', attempt: 2, nextAttemptAt: null, result: '{"result":"private result"}',
  safe: true, nested: false, recovered: true, resolution: null, verifiedNotExecuted: false,
  history: [{ attempt: 1, startedAt: at, finishedAt: '2026-09-17T00:00:00.100Z', outcome: 'failed', errorCode: 'ETIMEDOUT' },
    { attempt: 2, startedAt: '2026-09-17T00:00:01.000Z', finishedAt: '2026-09-17T00:00:01.100Z', outcome: 'succeeded', errorCode: null }] }]

it('uses durable attempts once, preserves the initial timeout, and stores no raw payloads', () => {
  const { trace, items } = projectTrace(run, [], [], 4000, calls)
  const fact = projectAnalysis(run, trace, items, undefined, [], at)
  expect(fact.attempts).toHaveLength(2)
  expect(summarize([fact]).tools).toMatchObject({ successRate: 0.5, logicalSuccessRate: 1, retries: 1, timeoutRate: 0.5 })
  expect(summarize([fact]).errors).toEqual([])
  expect(JSON.stringify(fact)).not.toContain('private result')
  expect(JSON.stringify(fact)).not.toContain('secret')
  expect(projectAnalysis(run, trace, [...items, ...items], undefined, [], at)).toEqual(fact)
  const shared = resourceMetrics([fact, { ...fact, runId: 'b', agentId: 'b' }])
  expect(shared[0]).toMatchObject({ affectedAgents: 2, affectedRuns: 2 })
})

it('does not turn an operator-confirmed unknown attempt into a measured success', () => {
  const human = { ...run, events: [
    { eventId: 'blocked', runId: run.id, agentId: run.agentId, agentVersionId: run.agentVersionId, sessionId: run.sessionId, type: 'run.blocked' as const, occurredAt: at },
    { eventId: 'resolved', runId: run.id, agentId: run.agentId, agentVersionId: run.agentVersionId, sessionId: run.sessionId,
      type: 'run.resolved' as const, occurredAt: run.finishedAt!, interventionId: 'blocked', actorId: 'admin' },
  ] }
  const journal = [{ ...calls[0]!, attempt: 1, history: [{ ...calls[0]!.history[0]!, outcome: 'unknown' as const, finishedAt: null }],
    resolution: { token: 'token', evidence: 'private evidence', decision: 'completed' as const, at: run.finishedAt! } }]
  const { trace, items } = projectTrace(human, [], [], 4000, journal)
  const fact = projectAnalysis(human, trace, items, undefined, [], at)
  expect(fact.attempts[0]).toMatchObject({ outcome: 'unknown', durationMs: null })
  expect(summarize([fact])).toMatchObject({ interventionRuns: 1, resolvedInterventions: 1, tools: { successRate: null } })
  expect(items.filter(item => item.type.startsWith('human.'))).toHaveLength(2)
})

it('retains Runtime failure with missing Trace and excludes detected timestamps from latency', () => {
  const failed = { ...run, status: 'FAILED' as const, finishTimeSource: 'detected' as const }
  const { trace, items } = projectTrace(failed, [], [], 4000)
  const fact = projectAnalysis(failed, { ...trace, state: 'unavailable' }, items, undefined, [], at)
  expect(fact).toMatchObject({ status: 'FAILED', finishedAt: null, durationMs: null, usageComplete: false })
  expect(summarize([fact])).toMatchObject({ failed: 1, successRate: 0, tokens: { average: null } })
})

it('keeps invalid arguments rejected before dispatch out of actual tool attempt rates', () => {
  const reliable = runSchema.parse({ ...run, runtime: { attempt: 1, checkpointSeq: -1, deadlineAt: run.finishedAt } })
  const callId = ToolCallId('bad')
  const events: SessionEvent[] = [
    { type: 'tool/call', seq: SessionSeq(0), time: Date.parse(at), data: { turn: 1, step: 1, callId, name: 'search', arguments: '{}' } },
    { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(1), time: Date.parse(at) + 1, data: { turn: 1, step: 1,
      error: { name: 'InvalidArguments', code: 'INVALID_ARGS' }, message: createToolResultMessage({ callId, isError: true,
        content: [{ type: 'text', text: 'Missing query' }] }) } },
  ]
  const { trace, items } = projectTrace(reliable, events, [], 4000)
  const fact = projectAnalysis(reliable, trace, items, undefined, [], at)
  expect(fact.rejections).toMatchObject([{ category: 'invalid_params' }])
  expect(summarize([fact])).toMatchObject({ rejectedCalls: 1, tools: { count: 0, successRate: null } })
})
