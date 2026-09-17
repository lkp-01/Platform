/** Agent-scoped Run index and directly addressable lifecycle details. */
import { useEffect, useRef, useState } from 'react'
import type { AgentHistoryPage, AgentVersionSummary, PlatformRun, RegistryAgent, RunStatus } from '@deepseek-ai/dsh-agent-builder/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { VersionActions } from './AgentVersions.tsx'
import { RunDetails, runDuration } from './RunDetails.tsx'
import { RunTrace } from './RunTrace.tsx'
import css from './AgentRegistry.module.css'

const statuses: RunStatus[] = ['PENDING', 'RUNNING', 'RETRY_WAIT', 'RECOVERING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED']
const active = (run: PlatformRun) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)
type Props = Pick<VersionActions, 'runList' | 'runGet' | 'runCancel' | 'runResolve' | 'openRun' | 'runTraceEvents'> & PropsLocale<'agentRegistry'> & {
  agent: RegistryAgent
  refreshKey: number
  versions: AgentVersionSummary[]
  viewVersion(id: string): Promise<void>
}

/** Read and refresh only the displayed tasks, stopping polls at completion.
 * @param props - Agent scope, locale and Remote actions.
 * @returns filters, task list and selected task details.
 */
export function AgentRuns(props: Props) {
  const { agent, t } = props
  const [page, setPage] = useState<AgentHistoryPage<PlatformRun> | null>(null)
  const [status, setStatus] = useState<RunStatus | ''>('')
  const [version, setVersion] = useState('')
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<PlatformRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now)
  const actions = useRef(props)
  actions.current = props
  const selectedId = /^#agents\/[^/]+\/runs\/([a-zA-Z0-9-]+)$/.exec(window.location.hash)?.[1]
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const [rows, detail] = await Promise.all([
          actions.current.runList(agent.platformWorkspaceId, agent.id, cursor, version || undefined, status || undefined),
          selectedId === undefined ? Promise.resolve(null) : actions.current.runGet(agent.platformWorkspaceId, agent.id, selectedId),
        ])
        if (!alive) return
        setPage(rows); setSelected(detail); setNow(Date.now())
        if (rows.items.some(active) || (detail !== null && active(detail))) timer = setTimeout(() => { void load() }, 1000)
      } catch (failure) { if (alive) setError(String(failure)) }
    }
    void load()
    return () => { alive = false; clearTimeout(timer) }
  }, [agent.id, agent.platformWorkspaceId, cursor, status, version, selectedId, props.refreshKey, refresh])

  const cancel = async () => {
    if (selected === null || busy) return
    setBusy(true); setError(null); setCancelFailed(false)
    try { setSelected(await props.runCancel(agent.platformWorkspaceId, agent.id, selected.id)); setRefresh(value => value + 1) }
    catch (failure) { setCancelFailed(true); setError(String(failure)) }
    finally { setBusy(false) }
  }
  const resolve = async (callId: string, decision: 'completed' | 'not-executed', evidence: string) => {
    if (selected === null || busy || props.runResolve === undefined) return
    setBusy(true); setError(null)
    try {
      setSelected(await props.runResolve(agent.platformWorkspaceId, agent.id, selected.id, callId, decision, evidence, randomUUID()))
      setRefresh(value => value + 1)
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  return <div className={css.detail}>
    {selected !== null && <div><Button variant="outline" onClick={() => { window.location.hash = `agents/${agent.id}` }}>{t('backRuns')}</Button></div>}
    {selected !== null && <RunDetails t={t} run={selected} agentName={agent.name} now={now}
      busy={busy || (selected.cancelRequestedAt !== null && !cancelFailed)} cancel={() => { void cancel() }}
      resolve={props.runResolve === undefined ? undefined : resolve}
      openExecution={() => { props.openRun(selected) }} viewVersion={() => { void props.viewVersion(selected.agentVersionId) }} />}
    {selected !== null && <RunTrace key={selected.id} run={selected} t={t} load={props.runTraceEvents} />}
    <div className={css.filters}><label>{t('runStatus')}<select aria-label={t('runStatus')} value={status}
      onChange={(event) => { const value = statuses.find(item => item === event.target.value); setStatus(value ?? ''); setCursor(0) }}>
      <option value="">{t('all')}</option>{statuses.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    <label>{t('versionFilter')}<select aria-label={t('versionFilter')} value={version}
      onChange={(event) => { setVersion(event.target.value); setCursor(0) }}>
      <option value="">{t('allVersions')}</option>{props.versions.map(item => <option key={item.id} value={item.id}>{t('versionPrefix')}{item.versionNumber}</option>)}
    </select></label></div>
    {error !== null && <p role="alert">{error}</p>}
    {page === null && error === null && <p role="status">{t('loading')}</p>}
    {page?.items.length === 0 && <p>{t('noRuns')}</p>}
    <div className={css.versionRows}>{page?.items.map((run) => {
      const duration = runDuration(run, now)
      return <article className={css.versionRow} key={run.id} data-run={run.id}>
        <div><strong>{t(run.status)}</strong><p>{run.id}</p><small>{t('versionPrefix')}{run.versionNumber} · {run.createdBy} · {new Date(run.createdAt).toLocaleString()}</small>
          <p>{t('duration')}: {duration === null ? t('unknown') : `${Math.floor(duration / 1000)} ${t('seconds')}`}</p>
          {run.error !== null && <p>{run.error.message}</p>}</div>
        <div className={css.actions}><Button variant="outline" onClick={() => { window.location.hash = `agents/${agent.id}/runs/${run.id}` }}>{t('runDetails')}</Button>
          <Button variant="outline" onClick={() => { void props.viewVersion(run.agentVersionId) }}>{t('versionPrefix')}{run.versionNumber}</Button>
          <Button variant="outline" onClick={() => { props.openRun(run) }}>{t('openRun')}</Button></div>
      </article>
    })}</div>
    <div className={css.actions}>
      {cursor > 0 && <Button variant="outline" onClick={() => { setCursor(0) }}>{t('first')}</Button>}

      {page?.nextCursor != null && <Button variant="outline"
        onClick={() => { if (page.nextCursor !== null) setCursor(page.nextCursor) }}>{t('next')}</Button>}</div>

  </div>
}
