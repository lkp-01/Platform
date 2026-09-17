/** Read-only task facts with a platform cancellation action. */
import { useState } from 'react'
import type { PlatformRun } from '@deepseek-ai/dsh-agent-builder/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AgentRegistry.module.css'

/** Compute elapsed execution time, leaving unknown historical timing unknown.
 * @param run - server lifecycle facts.
 * @param now - current display time in milliseconds.
 * @returns milliseconds or null when execution timing is unavailable.
 */
export function runDuration(run: PlatformRun, now: number): number | null {
  if (run.startedAt === null || run.finishTimeSource === 'detected') return null
  const end = run.finishedAt === null && run.runtime !== undefined ? now : run.status === 'RUNNING' ? now : run.finishedAt === null ? null : Date.parse(run.finishedAt)
  return end === null ? null : Math.max(0, end - Date.parse(run.startedAt))
}

type Props = PropsLocale<'agentRegistry'> & {
  run: PlatformRun
  agentName: string
  now: number
  busy: boolean
  cancel: () => void
  openExecution: () => void
  viewVersion: () => void
  resolve?: ((callId: string, decision: 'completed' | 'not-executed', evidence: string) => Promise<void>) | undefined
}

/** Display the fixed version, lifecycle, input and bounded final output.
 * @param props - localized task facts and actions.
 * @returns Run detail section.
 */
export function RunDetails({ run, agentName, now, busy, cancel, openExecution, viewVersion, resolve, t }: Props) {
  const [callId, setCallId] = useState('')
  const [evidence, setEvidence] = useState('')
  const [decision, setDecision] = useState<'completed' | 'not-executed'>('completed')
  const elapsed = runDuration(run, now)
  const date = (value: string | null) => value === null ? t('unknown') : new Date(value).toLocaleString()
  const active = !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)
  return <section className={css.snapshot} aria-label={t('runDetails')} data-run-status={run.status}>
    <h2>{t('runDetails')} · {run.id}</h2>
    <dl><dt>{t('name')}</dt><dd>{agentName}</dd><dt>{t('versionId')}</dt><dd>{t('versionPrefix')}{run.versionNumber} · {run.agentVersionId}</dd>
      <dt>{t('runStatus')}</dt><dd>{t(run.status)}{active && run.cancelRequestedAt !== null && <> · {t('cancelling')}</>}</dd>
      <dt>{t('initiatedBy')}</dt><dd>{run.createdBy}</dd><dt>{t('created')}</dt><dd>{date(run.createdAt)}</dd>
      <dt>{t('started')}</dt><dd>{date(run.startedAt)}</dd><dt>{t('finished')}</dt><dd>{date(run.finishedAt)}</dd>
      <dt>{t('duration')}</dt><dd>{elapsed === null ? t('unknown') : `${Math.floor(elapsed / 1000)} ${t('seconds')}`}</dd></dl>
    {run.finishTimeSource === 'detected' && <p>{t('detectedEnd')}</p>}
    {run.runtime !== undefined && <dl><dt>{t('runtimeAttempt')}</dt><dd>{run.runtime.attempt}</dd>
      <dt>{t('runtimeCheckpoint')}</dt><dd>{date(run.runtime.checkpointAt)} · {run.runtime.checkpointSeq}</dd>
      <dt>{t('runtimeRetry')}</dt><dd>{date(run.runtime.nextAttemptAt)}</dd>
      <dt>{t('runtimeDeadline')}</dt><dd>{date(run.runtime.deadlineAt)}</dd></dl>}
    <div className={css.actions}>{active && <Button disabled={busy} onClick={cancel}>{busy ? t('cancelling') : t('cancelRun')}</Button>}
      <Button variant="outline" onClick={viewVersion}>{t('viewVersion')}</Button>
      <Button variant="outline" onClick={openExecution}>{t('openRun')}</Button></div>
    <h3>{t('runInput')}</h3><pre className={css.prompt}>{run.input?.prompt ?? t('unknown')}</pre>
    <h3>{t('runResult')}</h3><pre className={css.prompt}>{run.result?.textPreview ?? '—'}</pre>
    {run.error !== null && <><h3>{t('runError')}</h3><pre role="alert" className={css.prompt}>{run.error.code}: {run.error.message}</pre></>}
    {run.status === 'BLOCKED' && resolve !== undefined && <fieldset className={css.form} disabled={busy}><legend>{t('runtimeResolve')}</legend>
      <p>{t('runtimeResolveHint')}</p>
      <label>{t('runtimeCallId')}<input value={callId} onChange={(event) => { setCallId(event.target.value) }} /></label>
      <label>{t('runtimeOutcome')}<select value={decision} onChange={(event) => { setDecision(event.target.value === 'completed' ? 'completed' : 'not-executed') }}>
        <option value="completed">{t('runtimeCompleted')}</option><option value="not-executed">{t('runtimeNotExecuted')}</option></select></label>
      <label>{t('runtimeEvidence')}<textarea rows={3} value={evidence} onChange={(event) => { setEvidence(event.target.value) }} maxLength={4000} /></label>
      <div className={css.actions}><Button disabled={busy || callId.trim() === '' || evidence.trim() === ''}
        onClick={() => { void resolve(callId.trim(), decision, evidence) }}>{t('runtimeResolve')}</Button></div>
    </fieldset>}
    <details><summary>{t('runEvents')}</summary>{run.events.map(event => <p key={event.eventId}>{event.type} · {date(event.occurredAt)}</p>)}</details>
  </section>
}
