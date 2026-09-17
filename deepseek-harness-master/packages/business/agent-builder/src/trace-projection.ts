/** Pure projection of Harness logs and platform model-start observations. */
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PlatformRun } from './types.ts'
import type { PlatformRuns } from './platform-runs.ts'
import type { RunTrace, TraceEvent, TraceModelStart, TracePreview, TraceUsage } from './trace-types.ts'

/** Sanitize a bounded preview without changing the original Session record.
 * @param text - untrusted argument or output text.
 * @param limit - maximum retained Unicode code points.
 * @returns escaped-by-renderer text and explicit truncation/redaction flags.
 */
export function tracePreview(text: string, limit: number): TracePreview {
  const safe = text.replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|(?:client[_-]?)?secret|authorization)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|[^\s,}]+)/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
  const points = Array.from(safe)
  return { text: points.slice(0, limit).join(''), truncated: points.length > limit, redacted: safe !== text }
}

function usageOf(usage: TokenUsage | undefined): TraceUsage | null {
  if (usage === undefined) return null
  const count = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n >= 0
  if (!count(usage.inputTokens) || !count(usage.outputTokens)) return null
  if ((usage.cacheReadTokens !== undefined && !count(usage.cacheReadTokens))
    || (usage.cacheWriteTokens !== undefined && !count(usage.cacheWriteTokens))
    || (usage.reasoningTokens !== undefined && (!count(usage.reasoningTokens) || usage.reasoningTokens > usage.outputTokens))) return null
  const known = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  let total = usage.totalTokens
    ?? (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined ? known + usage.outputTokens : null)
  if (total !== null && (!count(total) || total < known + usage.outputTokens
    || (usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined && total !== known + usage.outputTokens))) total = null
  return { inputTokens: total === null ? null : total - usage.outputTokens, outputTokens: usage.outputTokens, totalTokens: total,
    uncachedInputTokens: usage.inputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }) }
}

/** Build a deterministic timeline; replay replaces facts rather than incrementing counters.
 * @param run - authoritative task lifecycle.
 * @param events - original Session events in source order.
 * @param starts - persisted platform timing observations.
 * @param previewLimit - configured maximum preview characters.
 * @param tools - durable tool attempts made during recovery.
 * @returns source-ordered facts and summary without a storage revision.
 */
export function projectTrace(
  run: PlatformRun, events: readonly SessionEvent[], starts: readonly TraceModelStart[], previewLimit: number,
  tools: ReturnType<PlatformRuns['toolHistory']> = [],
): { items: TraceEvent[]; trace: RunTrace } {
  const rows: { order: number; event: TraceEvent }[] = []
  const add = (order: number, fields: Pick<TraceEvent, 'eventId' | 'type' | 'occurredAt'> & Partial<TraceEvent>) => {
    const event: TraceEvent = { sourceSeq: null, sourceRunEventId: null, operationId: null, turn: null, step: null,
      provider: null, model: null, tool: null, durationMs: null, preview: null, usage: null, error: null, incomplete: false, ...fields }
    rows.push({ order, event }); return event
  }
  const used = new Set<string>()
  const calls = new Map<string, TraceEvent>()
  let route: { provider: string; model: string } | null = null
  const terminal = run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'CANCELLED'
  const lastSeq = events.at(-1)?.seq ?? -1
  const recordedTools = new Set(tools.filter(tool => tool.history.length > 0).map(tool => tool.callId))
  for (const tool of tools) for (const attempt of tool.history) {
    const id = `${tool.id}:attempt:${attempt.attempt}`
    const order = events.findLast(event => event.time <= Date.parse(attempt.startedAt))?.seq ?? lastSeq
    add(order + 0.6, { eventId: `${id}:start`, type: attempt.attempt === 1 ? 'tool.call.started' : 'tool.retry.started', occurredAt: attempt.startedAt,
      operationId: tool.id, attemptId: id, attemptNumber: attempt.attempt, tool: tool.name,
      dispatched: true, preview: tracePreview(tool.arguments, previewLimit), incomplete: attempt.finishedAt === null })
    if (attempt.finishedAt !== null) add(order + 0.7, { eventId: `${id}:end`,
      type: attempt.attempt === 1 ? (attempt.outcome === 'succeeded' ? 'tool.call.completed' : 'tool.call.failed')
        : attempt.outcome === 'succeeded' ? 'tool.retry.completed' : 'tool.retry.failed', occurredAt: attempt.finishedAt,
      operationId: tool.id, attemptId: id, attemptNumber: attempt.attempt, tool: tool.name, dispatched: true,
      error: attempt.outcome === 'failed' ? { code: attempt.errorCode ?? 'UNKNOWN', message: attempt.errorCode ?? 'UNKNOWN' } : null,
      preview: attempt.attempt === tool.attempt && tool.result !== null ? tracePreview(tool.result, previewLimit) : null,
      incomplete: attempt.outcome === 'unknown', durationMs: Math.max(0, Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) })
  }
  for (const start of starts) add(start.afterSeq + 0.5, { eventId: start.id, type: 'model.call.started', occurredAt: start.occurredAt,
    operationId: start.id, turn: start.turn, step: start.step, provider: start.provider, model: start.model })
  for (const event of events) {
    const base = { eventId: `${run.id}:session:${event.seq}`, occurredAt: new Date(event.time).toISOString(), sourceSeq: event.seq }
    if (event.type === 'request/context') route = event.data
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const data = event.data
      const start = starts.findLast(item => !used.has(item.id) && item.turn === data.turn
        && item.step === data.step && item.afterSeq < event.seq)
      if (start !== undefined) used.add(start.id)
      const finish = lastAssistantStreamChunk(data.stream, 'finish')?.reason
      const interrupted = event.type === 'assistant/message' && event.data.interrupted === true
      const failed = event.type === 'assistant/attempt'
      const source = event.type === 'assistant/message' ? event.data.message.source : route
      const usage = event.type === 'assistant/message' ? event.data.usage ?? lastAssistantStreamChunk(data.stream, 'usage')?.usage : lastAssistantStreamChunk(data.stream, 'usage')?.usage
      const error = finish?.kind === 'error' || finish?.kind === 'aborted' ? { code: finish.failure.code, message: tracePreview(finish.failure.message, previewLimit).text } : null
      const cancelled = interrupted || finish?.kind === 'aborted' || (failed && run.status === 'CANCELLED' && finish === undefined)
      add(event.seq, { ...base, type: cancelled ? 'model.call.cancelled' : failed ? 'model.call.failed' : 'model.call.completed',
        operationId: start?.id ?? base.eventId, turn: data.turn, step: data.step,
        provider: source?.provider ?? start?.provider ?? null, model: source?.model ?? start?.model ?? null,
        durationMs: start === undefined ? null : Math.max(0, event.time - Date.parse(start.occurredAt)),
        usage: usageOf(usage), error, incomplete: start === undefined,
        preview: event.type === 'assistant/message' ? tracePreview(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), previewLimit) : null,
      })
    }
    if (event.type === 'tool/call') {
      if (recordedTools.has(event.data.callId)) continue
      const key = `${event.data.turn}:${event.data.step}:${event.data.callId}`
      const row = add(event.seq, { ...base, type: 'tool.call.started', operationId: `${run.id}:tool:${key}`,
        ...(run.runtime === undefined ? {} : { dispatched: false }),
        turn: event.data.turn, step: event.data.step, tool: event.data.name, preview: tracePreview(event.data.arguments, previewLimit) })
      calls.set(key, row)
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      if (recordedTools.has(block.toolCallId)) continue
      const key = `${event.data.turn}:${event.data.step}:${block.toolCallId}`
      const call = calls.get(key)
      const repaired = event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || event.data.error?.code === 'TOOL_NOT_STARTED'
      add(event.seq, { ...base, type: block.isError ? 'tool.call.failed' : 'tool.call.completed', operationId: call?.operationId ?? `${run.id}:tool:${key}`,
        ...(run.runtime === undefined ? {} : { dispatched: false }),
        turn: event.data.turn, step: event.data.step, tool: call?.tool ?? null, incomplete: repaired || call === undefined,
        durationMs: call === undefined || repaired ? null : Math.max(0, event.time - Date.parse(call.occurredAt)),
        preview: tracePreview(block.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), previewLimit),
        error: block.isError ? { code: event.data.error?.code ?? 'TOOL_ERROR', message: event.data.error?.name ?? 'TOOL_ERROR' } : null })
      calls.delete(key)
    }
    // Plugin-merged retry records are optional vocabulary, read at the durable JSON boundary.
    if (event.type as string === 'llm/retry') {
      const data = event.data as unknown as { turn: number; step: number; delayMs: number; failure: { code: string; message: string } }
      add(event.seq, { ...base, type: 'model.retry.scheduled', turn: data.turn, step: data.step,
        preview: tracePreview(JSON.stringify({ delayMs: data.delayMs }), previewLimit),
        error: { code: data.failure.code, message: tracePreview(data.failure.message, previewLimit).text } })
    }
  }
  for (const event of run.events) {
    const order = event.type === 'run.created' ? -2 : event.type === 'run.started' ? (events.find(item => item.type === 'turn/start')?.seq ?? -1) : lastSeq + 2
    add(order, { eventId: `${event.eventId}:lifecycle`, type: event.type, occurredAt: event.occurredAt, sourceRunEventId: event.eventId,
      error: event.type === 'run.failed' && run.error !== null ? { code: run.error.code, message: tracePreview(run.error.message, previewLimit).text } : null,
      incomplete: event.type === 'run.failed' && run.finishTimeSource === 'detected' })
    if (event.type === 'run.blocked' || event.type === 'run.resolved') add(order + 0.1, {
      eventId: `${event.eventId}:intervention`, sourceRunEventId: event.eventId,
      type: event.type === 'run.blocked' ? 'human.intervention.requested' : 'human.intervention.resolved',
      occurredAt: event.occurredAt,
      ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
      ...(event.type === 'run.blocked' ? { interventionId: event.eventId }
        : event.interventionId === undefined ? {} : { interventionId: event.interventionId }),
    })
  }
  if (run.status === 'SUCCEEDED' && run.result?.textPreview) {
    const final = events.find(event => event.seq === run.result?.finalMessageSeq)
    if (final?.type === 'assistant/message' && !final.data.interrupted) add(lastSeq + 1, {
      eventId: `${run.id}:final`, type: 'final.answer', occurredAt: new Date(final.time).toISOString(), sourceSeq: final.seq,
      preview: tracePreview(final.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), previewLimit) })
  }
  const items = rows.sort((a, b) => a.order - b.order || a.event.eventId.localeCompare(b.event.eventId)).map(row => row.event)
  const settlements = items.filter(item => ['model.call.completed', 'model.call.failed', 'model.call.cancelled'].includes(item.type))
  const modelCalls = starts.length + settlements.filter(item => item.incomplete).length
  const usages = settlements.flatMap(item => item.usage === null ? [] : [item.usage])
  const sum = (field: keyof TraceUsage): number | null => {
    const values = usages.map(item => item[field]).filter((value): value is number => value !== null)
    const value = values.reduce((a, b) => a + b, 0)
    return values.length === 0 || !Number.isSafeInteger(value) ? null : value
  }
  const incomplete = items.some(item => item.incomplete) || (terminal && (calls.size > 0 || used.size < starts.length))
  return { items, trace: { runId: run.id, sessionId: run.sessionId, agentId: run.agentId, agentVersionId: run.agentVersionId,
    platformWorkspaceId: run.platformWorkspaceId, revision: '', state: terminal ? incomplete ? 'partial' : 'complete' : 'pending',
    eventCount: items.length, modelCalls, toolCalls: items.filter(item => item.type === 'tool.call.started' || item.type === 'tool.retry.started').length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    usageComplete: modelCalls > 0 && modelCalls === usages.length && usages.every(item => item.totalTokens !== null) && sum('totalTokens') !== null } }
}
