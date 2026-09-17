/** Run state transitions and projection of the original Harness execution facts. */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { RunRecord } from './run-schema.ts'
import type { RunStatus } from './types.ts'

/** Check whether no further task execution is permitted.
 * @param status - persisted task status.
 * @returns whether the task has ended.
 */
export function isRunTerminal(status: RunStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED'
}

/** Commit a lifecycle fact into the same record as its status.
 * @param row - current persisted facts.
 * @param status - requested destination.
 * @param at - time of the observed fact.
 * @param patch - result or error accompanying the transition.
 * @returns immutable next record; terminal or duplicate transitions are ignored.
 */
export function transitionRun(row: RunRecord, status: RunStatus, at: string, patch: Partial<RunRecord> = {}): RunRecord {
  if (isRunTerminal(row.status) || row.status === status) return row
  if (status === 'PENDING' || (status === 'SUCCEEDED' && row.status !== 'RUNNING')) throw new Error(`Invalid Run transition ${row.status} -> ${status}`)
  const type = { RUNNING: 'run.started', SUCCEEDED: 'run.succeeded', FAILED: 'run.failed', CANCELLED: 'run.cancelled' } as const
  return { ...row, ...patch, status,
    ...(status === 'RUNNING' ? { startedAt: at } : { finishedAt: at, finishTimeSource: patch.finishTimeSource ?? 'execution' }),
    events: [...row.events, { eventId: `${row.id}:${row.events.length}`, runId: row.id, agentId: row.agentId,
      agentVersionId: row.agentVersionId, sessionId: row.sessionId, type: type[status], occurredAt: at }],
  }
}

function outcome(reason: TurnEndReason): { status: RunStatus; error: RunRecord['error'] } {
  if (reason.kind === 'completed') return { status: 'SUCCEEDED', error: null }
  if (reason.kind === 'aborted' && (reason.reason.kind === 'user' || reason.reason.kind === 'legacy')) return { status: 'CANCELLED', error: null }
  if (reason.kind === 'error') return { status: 'FAILED', error: { code: reason.error.code, message: reason.error.message } }
  return { status: 'FAILED', error: { code: reason.kind === 'interrupted' || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')
    ? 'EXECUTION_INTERRUPTED' : 'EXECUTION_STOPPED', message: `Harness ended: ${reason.kind}` } }
}

/** Fold execution facts without storing the transcript a second time.
 * @param source - persisted Run.
 * @param events - ordered original Session events.
 * @param detectedAt - time used when an interrupted end was synthesized on read.
 * @returns updated lifecycle, bounded final text and source cursor.
 */
export function projectRun(source: RunRecord, events: readonly SessionEvent[], detectedAt: string): RunRecord {
  let row = source
  let final: SessionEvent<'assistant/message'> | undefined
  for (const event of events) {
    if (event.type === 'assistant/message' && !event.data.interrupted) final = event
    if (event.seq <= source.lastSessionSeq || isRunTerminal(row.status)) continue
    const at = new Date(event.time).toISOString()
    if (event.type === 'turn/start') row = transitionRun(row, 'RUNNING', at)
    if (event.type === 'user/message' && row.input === null) {
      row = { ...row, input: { prompt: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') } }
    }
    if (event.type === 'turn/end') {
      const end = outcome(event.data.reason)
      const interrupted = event.data.reason.kind === 'interrupted'
      const text = final?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
      row = transitionRun(row, end.status, interrupted ? detectedAt : at, { error: end.error,
        finishTimeSource: interrupted ? 'detected' : 'execution',
        result: end.status === 'SUCCEEDED' ? { textPreview: text.length === 0 ? null : [...text].slice(0, 4000).join(''),
          sessionId: row.sessionId, finalMessageSeq: final?.seq ?? null } : null,
      })
    }
    row = { ...row, lastSessionSeq: event.seq }
  }
  return row
}
