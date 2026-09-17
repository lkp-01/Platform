import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import { runSchema } from '../src/run-schema.ts'
import { projectRun, transitionRun } from '../src/run-lifecycle.ts'

const time = '2026-09-17T01:00:00.000Z'
const initial = () => runSchema.parse({ id: 'run-a', agentId: 'agent-a', agentVersionId: 'version-a', versionNumber: 1,
  platformWorkspaceId: 'shared', configHash: 'hash', deploymentRevision: 1, sessionId: 'session-a', createdAt: time,
  createdBy: 'shared-host', status: 'PENDING', error: null, fingerprint: 'hash', format: 2 })
function event<T extends SessionEventType>(type: T, seq: number, data: SessionEvent<T>['data']): SessionEvent<T> {
  return { type, seq: SessionSeq(seq), time: Date.parse(time) + seq * 1000, data } as SessionEvent<T>
}
const start = event('turn/start', 0, { turn: 1 })
const end = event('turn/end', 1, { turn: 1, reason: { kind: 'completed' } })

describe('platform Run lifecycle', () => {
  it('records actual start and end facts exactly once and ignores late events', () => {
    const completed = projectRun(initial(), [start, end], time)
    expect(completed).toMatchObject({ status: 'SUCCEEDED', startedAt: time, finishedAt: '2026-09-17T01:00:01.000Z',
      result: { textPreview: null, finalMessageSeq: null }, error: null })
    expect(projectRun(completed, [start, end], time)).toEqual(completed)
    expect(transitionRun(completed, 'CANCELLED', time)).toEqual(completed)
    expect(completed.events.map(value => value.type)).toEqual(['run.started', 'run.succeeded'])
  })
  it('distinguishes user cancellation from host disposal and synthesized interruption', () => {
    const user = event('turn/end', 1, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const disposed = event('turn/end', 1, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
    const interrupted = event('turn/end', 1, { turn: 1, reason: { kind: 'interrupted' } })
    expect(projectRun(initial(), [start, user], time).status).toBe('CANCELLED')
    expect(projectRun(initial(), [start, disposed], time)).toMatchObject({ status: 'FAILED', error: { code: 'EXECUTION_INTERRUPTED' } })
    expect(projectRun(initial(), [start, interrupted], time)).toMatchObject({ status: 'FAILED', finishTimeSource: 'detected', finishedAt: time })
  })
  it('allows pre-start failure and cancellation without inventing a start time', () => {
    expect(transitionRun(initial(), 'FAILED', time).startedAt).toBeNull()
    expect(transitionRun(initial(), 'CANCELLED', time).startedAt).toBeNull()
    expect(() => transitionRun(initial(), 'SUCCEEDED', time)).toThrow('Invalid Run transition')
  })
  it('retains bounded final text without exposing reasoning or splitting Unicode characters', () => {
    const message = event('assistant/message', 1, { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'demo', model: 'demo' }, content: [{ type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '😀'.repeat(4001) }],
    }) })
    const completed = projectRun(initial(), [start, message, event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })], time)
    expect(completed.result?.textPreview).toBe('😀'.repeat(4000))
    expect(completed.result?.finalMessageSeq).toBe(1)
  })
  it('decodes old rows without losing their migration identity or error', () => {
    const row = initial()
    const { format: _format, ...old } = row
    expect(runSchema.parse({ ...old, status: 'accepted', error: 'old failure' })).toMatchObject({ format: 1, status: 'PENDING',
      error: { code: 'LEGACY_ERROR', message: 'old failure' } })
  })
})
