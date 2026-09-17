import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { runSchema } from '../src/run-schema.ts'
import { projectRun } from '../src/run-lifecycle.ts'
import { projectTrace, tracePreview } from '../src/trace-projection.ts'
import type { TraceModelStart } from '../src/trace-types.ts'

const at = '2026-09-17T01:00:00.000Z'
const initial = () => runSchema.parse({ id: 'run-a', agentId: 'agent-a', agentVersionId: 'version-a', versionNumber: 1,
  platformWorkspaceId: 'shared', configHash: 'hash', deploymentRevision: 1, sessionId: 'session-a', createdAt: at,
  createdBy: 'shared-host', status: 'PENDING', error: null, fingerprint: 'hash', format: 2 })
function event<T extends SessionEventType>(type: T, seq: number, data: SessionEvent<T>['data']): SessionEvent<T> {
  return { type, seq: SessionSeq(seq), time: Date.parse(at) + seq * 1000, data } as SessionEvent<T>
}
const start: TraceModelStart = { id: 'start-a', runId: initial().id, afterSeq: 0, occurredAt: at, turn: 1, step: 1, provider: 'demo', model: 'actual' }
const message = event('assistant/message', 1, { turn: 1, step: 1, stream: [],
  usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 2, totalTokens: 19 },
  message: createAssistantMessage({ source: { provider: 'demo', model: 'actual' }, content: [{ type: 'text', text: 'Answer' }] }) })
const events = [event('turn/start', 0, { turn: 1 }), message, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })]

describe('Run Trace projection', () => {
  it('links actual model calls and final answers and counts cache tokens exactly once on replay', () => {
    const run = projectRun(initial(), events, at)
    const projected = projectTrace(run, events, [start], 4000)
    expect(projected.trace).toMatchObject({ state: 'complete', modelCalls: 1, inputTokens: 15, outputTokens: 4, totalTokens: 19, usageComplete: true })
    expect(projected.items.map(item => item.type)).toEqual(['run.started', 'model.call.started', 'model.call.completed', 'final.answer', 'run.succeeded'])
    expect(projected.items[2]).toMatchObject({ model: 'actual', sourceSeq: 1, operationId: start.id, durationMs: 1000 })
    expect(projectTrace(run, events, [start], 4000)).toEqual(projected)
  })
  it('keeps unknown timing and usage distinct from zero for historical calls', () => {
    const { usage: _usage, ...data } = message.data
    const old = [events[0]!, { ...message, data }, events[2]!]
    const projected = projectTrace(projectRun(initial(), old, at), old, [], 4000)
    expect(projected.trace).toMatchObject({ state: 'partial', modelCalls: 1, totalTokens: null, usageComplete: false })
    expect(projected.items.find(item => item.type === 'model.call.completed')).toMatchObject({ durationMs: null, usage: null, incomplete: true })
  })
  it('pairs parallel tool outcomes by callId and keeps recoverable tool failures separate from Run success', () => {
    const a = ToolCallId('a'), b = ToolCallId('b')
    const toolEvents = [events[0]!, event('tool/call', 1, { turn: 1, step: 1, callId: a, name: 'one', arguments: '{"password":"secret"}' }),
      event('tool/call', 2, { turn: 1, step: 1, callId: b, name: 'two', arguments: 'invalid JSON' }),
      event('tool/result', 3, { turn: 1, step: 1, message: createToolResultMessage({ callId: b, isError: false, content: [{ type: 'text', text: 'ok' }] }) }),
      event('tool/result', 4, { turn: 1, step: 1, message: createToolResultMessage({ callId: a, isError: true, content: [{ type: 'text', text: 'failed' }] }) }),
      event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } })]
    const projected = projectTrace(projectRun(initial(), toolEvents, at), toolEvents, [], 4000)
    expect(projected.trace.toolCalls).toBe(2)
    expect(projected.items.find(item => item.type === 'tool.call.completed')).toMatchObject({ tool: 'two', durationMs: 1000 })
    expect(projected.items.find(item => item.type === 'tool.call.failed')).toMatchObject({ tool: 'one', durationMs: 3000 })
    expect(projected.items.at(-1)?.type).toBe('run.succeeded')
    expect(JSON.stringify(projected)).not.toContain('secret')
  })
  it('does not count an interrupted prefix as a final answer', () => {
    const cancelled = [events[0]!, { ...message, data: { ...message.data, interrupted: true as const } },
      event('turn/end', 2, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })]
    const projected = projectTrace(projectRun(initial(), cancelled, at), cancelled, [start], 4000)
    expect(projected.items.some(item => item.type === 'final.answer')).toBe(false)
    expect(projected.items.find(item => item.type === 'model.call.cancelled')).toMatchObject({ durationMs: 1000 })
  })
  it('bounds Unicode previews and redacts credentials before truncating', () => {
    expect(tracePreview('😀'.repeat(20), 3)).toEqual({ text: '😀😀😀', truncated: true, redacted: false })
    expect(tracePreview('{"api_key":"sensitive","value":"ok"}', 100).text).toBe('{"api_key":"[REDACTED]","value":"ok"}')
  })
  it('counts failed and retried attempts separately without adding retry waiting to model latency', () => {
    const failed = event('assistant/attempt', 1, { turn: 1, step: 1, stream: [
      { type: 'chunk', time: Date.parse(at) + 900, chunk: { type: 'usage', usage: message.data.usage! } },
      { type: 'chunk', time: Date.parse(at) + 1000, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'retry me' } } } },
    ] })
    const retry = { type: 'llm/retry', seq: SessionSeq(2), time: Date.parse(at) + 2000,
      data: { turn: 1, step: 1, delayMs: 3000, failure: { code: 'HTTP', message: 'retry me' } } } as unknown as SessionEvent
    const second = { ...message, seq: SessionSeq(4), time: Date.parse(at) + 6000 }
    const retried = [events[0]!, failed, retry, second, event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } })]
    const nextStart = { ...start, id: 'start-b', afterSeq: 3, occurredAt: new Date(Date.parse(at) + 5000).toISOString() }
    const projected = projectTrace(projectRun(initial(), retried, at), retried, [start, nextStart], 4000)
    expect(projected.trace).toMatchObject({ modelCalls: 2, totalTokens: 38, usageComplete: true })
    expect(projected.items.filter(item => item.durationMs !== null).map(item => item.durationMs)).toEqual([1000, 1000])
    expect(projected.items.find(item => item.type === 'model.call.failed')?.error).toEqual({ code: 'HTTP', message: 'retry me' })
  })
  it('does not report repair timestamps as the latency of interrupted tools', () => {
    const callId = ToolCallId('lost')
    const lost = [events[0]!, event('tool/call', 1, { turn: 1, step: 1, callId, name: 'remote', arguments: '{}' }),
      event('tool/result', 2, { turn: 1, step: 1, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        message: createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: 'outcome unknown' }] }) }),
      event('turn/end', 3, { turn: 1, reason: { kind: 'interrupted' } })]
    const projected = projectTrace(projectRun(initial(), lost, at), lost, [], 4000)
    expect(projected.trace.state).toBe('partial')
    expect(projected.items.find(item => item.type === 'tool.call.failed')).toMatchObject({ durationMs: null, incomplete: true })
  })
})
