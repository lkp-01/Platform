/** Run-scoped timeline with bounded pagination and independently settling Trace polls. */
import { useEffect, useRef, useState } from 'react'
import type { PlatformRun, RunTracePage, TraceEvent } from '@deepseek-ai/dsh-agent-builder/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VersionActions } from './AgentVersions.tsx'
import css from './AgentRegistry.module.css'

type Props = PropsLocale<'agentRegistry'> & { run: PlatformRun; load: VersionActions['runTraceEvents'] }

/** Fetch and display persisted facts; task completion and Trace completion are independent.
 * @param props - authorized Run and apply-owned query callback.
 * @returns summary, source-ordered timeline and explicit availability states.
 */
export function RunTrace({ run, load, t }: Props) {
  const [page, setPage] = useState<RunTracePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(100)
  const action = useRef(load)
  action.current = load
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      setBusy(true)
      try {
        let result = await action.current(run.platformWorkspaceId, run.agentId, run.id)
        while (result.items.length < visible && result.nextCursor !== null) {
          const next = await action.current(run.platformWorkspaceId, run.agentId, run.id, result.nextCursor)
          result = { ...next, items: [...result.items, ...next.items] }
        }
        if (!alive) return
        setPage(result); setError(null)
        if (result.trace.state === 'pending') timer = setTimeout(() => { void read() }, 1000)
      } catch (failure) { if (alive) setError(String(failure)) }
      finally { if (alive) setBusy(false) }
    }
    void read()
    return () => { alive = false; clearTimeout(timer) }
  }, [run.id, run.agentId, run.platformWorkspaceId, refresh, visible])
  const trace = page?.trace
  return <section className={css.snapshot} aria-label={t('traceTitle')} data-trace-state={trace?.state}>
    <div className={css.actions}><h2>{t('traceTitle')}</h2><Button variant="outline" disabled={busy} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button></div>
    {error !== null && <p role="alert">{error}</p>}
    {trace === undefined ? <p role="status">{t('loading')}</p> : <>
      <p role="status">{t(`trace_${trace.state}`)}</p>
      <dl className={css.traceMetrics}>
        <div><dt>{t('traceModelCalls')}</dt><dd>{trace.modelCalls}</dd></div>
        <div><dt>{t('traceToolCalls')}</dt><dd>{trace.toolCalls}</dd></div>
        <div><dt>{t('traceInputTokens')}</dt><dd>{trace.inputTokens ?? t('unknown')}</dd></div>
        <div><dt>{t('traceOutputTokens')}</dt><dd>{trace.outputTokens ?? t('unknown')}</dd></div>
        <div><dt>{t('traceTotalTokens')}</dt><dd>{trace.totalTokens ?? t('unknown')}</dd></div>
      </dl>
      {!trace.usageComplete && <p>{t('traceUsagePartial')}</p>}
      <ol className={css.traceTimeline}>{page?.items.map(event => <TraceRow key={event.eventId} event={event} t={t} />)}</ol>
      {page?.nextCursor !== null && <Button variant="outline" disabled={busy} onClick={() => { setVisible(value => value + 100) }}>{t('traceMore')}</Button>}
      <p>{t('traceOriginalHint')}</p>
    </>}
  </section>
}

function TraceRow({ event, t }: PropsLocale<'agentRegistry'> & { event: TraceEvent }) {
  const label = t(`trace_${event.type}`)
  return <li data-trace-event={event.type} className={css.traceRow}>
    <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleTimeString()}</time>
    <details><summary><strong>{label}</strong>{event.model !== null && <> · {event.model}</>}{event.tool !== null && <> · {event.tool}</>}
      {event.durationMs !== null && <> · {event.durationMs} {t('traceMs')}</>}</summary>
    {event.provider !== null && <p>{t('traceProvider')}: {event.provider}</p>}
    {event.usage !== null && <p>{t('traceInputTokens')}: {event.usage.inputTokens ?? t('unknown')} · {t('traceOutputTokens')}: {event.usage.outputTokens}</p>}
    {event.incomplete && <p>{t('traceIncomplete')}</p>}
    {event.error !== null && <p role="alert">{event.error.code}: {event.error.message}</p>}
    {event.preview !== null && <><pre className={css.prompt}>{event.preview.text}</pre>
      {event.preview.truncated && <p>{t('traceTruncated')}</p>}{event.preview.redacted && <p>{t('traceRedacted')}</p>}</>}
    </details>
  </li>
}
