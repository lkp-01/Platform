/** Version history, default activation and task attribution inside Agent details. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDeployment, AgentHistoryPage, AgentVersion, AgentVersionSummary, PlatformRun, RegistryAgent } from '@deepseek-ai/dsh-agent-builder/types'
import css from './AgentRegistry.module.css'

/** Apply-owned version and task callbacks. */
export interface VersionActions {
  versionCreate(workspace: string, id: string, revision: number, token: string, note: string): Promise<AgentVersion>
  versionList(workspace: string, id: string, cursor: number): Promise<AgentHistoryPage<AgentVersionSummary>>
  versionGet(workspace: string, id: string, version: string): Promise<AgentVersion>
  deploymentGet(workspace: string, id: string): Promise<AgentDeployment | null>
  deploymentHistory(workspace: string, id: string, cursor: number): Promise<AgentHistoryPage<AgentDeployment>>
  deploymentActivate(workspace: string, id: string, version: string, revision: number, token: string, action: 'deploy' | 'rollback'): Promise<AgentDeployment>
  runStart(workspace: string, id: string, prompt: string, token: string): Promise<PlatformRun>
  runList(workspace: string, id: string, cursor: number, versionId?: string): Promise<AgentHistoryPage<PlatformRun>>
  openRun(run: PlatformRun): void
}

type Props = VersionActions & PropsLocale<'agentRegistry'> & { agent: RegistryAgent; mode: 'overview' | 'versions' | 'runs' }

/** Show saved versions separately from the mutable draft and active deployment.
 * @param props - resource, locale and transport actions.
 * @returns version management and bounded Run history.
 */
export function AgentVersionsPanel(props: Props) {
  const { agent, mode, t } = props
  const workspace = agent.platformWorkspaceId
  const [versions, setVersions] = useState<AgentHistoryPage<AgentVersionSummary> | null>(null)
  const [deployment, setDeployment] = useState<AgentDeployment | null>(null)
  const [active, setActive] = useState<AgentVersion | null>(null)
  const [history, setHistory] = useState<AgentHistoryPage<AgentDeployment> | null>(null)
  const [runs, setRuns] = useState<AgentHistoryPage<PlatformRun> | null>(null)
  const [selected, setSelected] = useState<AgentVersion | null>(null)
  const [cursor, setCursor] = useState(0)
  const [historyCursor, setHistoryCursor] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [prompt, setPrompt] = useState('')
  const [filter, setFilter] = useState('')
  const [latestRun, setLatestRun] = useState<PlatformRun | null>(null)
  const tokens = useRef({ version: randomUUID(), run: randomUUID(), deployment: randomUUID(), activation: '' })
  const actions = useRef(props)
  actions.current = props
  useEffect(() => { setCursor(0); setSelected(null) }, [mode])
  useEffect(() => { tokens.current.version = randomUUID() }, [agent.revision])
  useEffect(() => {
    let alive = true
    const live = () => alive
    setLoading(true); setError(null)
    void (async () => {
      try {
        const [saved, current, past, tasks] = await Promise.all([
          actions.current.versionList(workspace, agent.id, mode === 'versions' ? cursor : 0),
          actions.current.deploymentGet(workspace, agent.id),
          actions.current.deploymentHistory(workspace, agent.id, historyCursor),
          mode === 'runs' ? actions.current.runList(workspace, agent.id, cursor, filter || undefined) : Promise.resolve(null),
        ])
        const currentVersion = current === null ? null : await actions.current.versionGet(workspace, agent.id, current.versionId)
        if (!live()) return
        setVersions(saved); setDeployment(current); setActive(currentVersion); setHistory(past); setRuns(tasks)
      } catch (failure) { if (live()) setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { if (live()) setLoading(false) }
    })()
    return () => { alive = false }
  }, [workspace, agent.id, agent.revision, mode, cursor, historyCursor, filter, refresh])

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const view = (id: string) => perform(async () => { setSelected(await props.versionGet(workspace, agent.id, id)) })
  const save = () => perform(async () => {
    const value = await props.versionCreate(workspace, agent.id, agent.revision, tokens.current.version, note)
    setSelected(value); tokens.current.version = randomUUID(); setNote(''); setCursor(0); setRefresh(value => value + 1)
  })
  const activate = (version: AgentVersionSummary) => perform(async () => {
    const action = active !== null && version.versionNumber < active.versionNumber ? 'rollback' : 'deploy'
    const revision = deployment?.revision ?? 0
    const fingerprint = `${version.id}/${revision}/${action}`
    if (tokens.current.activation !== fingerprint) {
      tokens.current.activation = fingerprint; tokens.current.deployment = randomUUID()
    }
    const value = await props.deploymentActivate(workspace, agent.id, version.id, revision, tokens.current.deployment, action)
    setDeployment(value); setRefresh(value => value + 1)
  })
  const start = () => perform(async () => {
    const run = await props.runStart(workspace, agent.id, prompt, tokens.current.run)
    setLatestRun(run); tokens.current.run = randomUUID(); setPrompt(''); setRefresh(value => value + 1)
  })
  const disabled = busy || loading || agent.lifecycle === 'archived'
  const rows = mode === 'runs' ? runs : versions
  return <section className={css.detail} aria-label={t('versionManagement')}>
    <div className={css.actions}><span className={css.badge}>{t('currentVersion')}: {active === null ? t('notDeployed') : t('versionPrefix') + String(active.versionNumber)}</span>
      {mode === 'overview' && <span>{t('latestVersion')}: {versions?.items[0] === undefined ? t('noVersions') : t('versionPrefix') + String(versions.items[0].versionNumber)}</span>}
      <Button variant="outline" disabled={busy || loading} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button></div>
    {error !== null && <p role="alert" className={css.error}>{error}</p>}
    {loading && <p role="status">{t('loading')}</p>}
    {mode === 'versions' && <>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); void save() }}><p className={css.scope}>{t('versionHint')}</p>
        <label>{t('changeNote')}<input aria-label={t('changeNote')} maxLength={2000} value={note} onChange={(event) => { setNote(event.target.value); tokens.current.version = randomUUID() }} /></label>
        <div><Button type="submit" disabled={disabled}>{t('saveVersion')}</Button></div></form>
      {!loading && versions?.items.length === 0 && <p className={css.empty}>{t('noVersions')}</p>}
      <div className={css.versionRows}>{versions?.items.map(version => <article
        key={version.id} className={css.versionRow} data-version={version.versionNumber}>
        <div><strong>{t('versionPrefix')}{version.versionNumber}</strong> {deployment?.versionId === version.id && <span className={css.badge}>{t('deployed')}</span>}
          <p>{version.changeNote || '—'}</p><small>{version.model.provider} / {version.model.model} · {t('tools')}: {version.toolCount}
            {' · '}{version.createdBy} · {new Date(version.createdAt).toLocaleString()}</small></div>
        <div className={css.actions}><Button variant="outline" disabled={busy} onClick={() => { void view(version.id) }}>{t('viewVersion')}</Button>
          <Button disabled={disabled || deployment?.versionId === version.id} onClick={() => { void activate(version) }}>
            {active !== null && version.versionNumber < active.versionNumber ? t('rollback') : t('deploy')}</Button></div>
      </article>)}</div>
    </>}
    {(mode === 'overview' || mode === 'runs') && <form className={css.form} onSubmit={(event) => { event.preventDefault(); void start() }}>
      <p className={css.scope}>{t('runHint')}</p><label>{t('taskPrompt')}<textarea aria-label={t('taskPrompt')} rows={3} maxLength={32000} value={prompt}
        onChange={(event) => { setPrompt(event.target.value); tokens.current.run = randomUUID() }} /></label>
      <div><Button type="submit" disabled={disabled || deployment === null || !prompt.trim()}>{t('startRun')}</Button></div>
      {latestRun !== null && <div className={css.notice}><span>{latestRun.id} · {t('versionPrefix')}{latestRun.versionNumber} · {t(latestRun.status)}</span>
        {latestRun.error !== null && <p role="alert">{latestRun.error}</p>}<Button variant="outline" onClick={() => { props.openRun(latestRun) }}>{t('openRun')}</Button></div>}
    </form>}
    {mode === 'runs' && <>
      <div className={css.filters}><select aria-label={t('versionFilter')} value={filter} onChange={(event) => { setFilter(event.target.value); setCursor(0) }}>
        <option value="">{t('allVersions')}</option>{versions?.items.map(version => <option key={version.id} value={version.id}>{t('versionPrefix')}{version.versionNumber}</option>)}</select></div>
      {!loading && runs?.items.length === 0 && <p className={css.empty}>{t('noRuns')}</p>}
      <div className={css.versionRows}>{runs?.items.map(run => <article key={run.id} className={css.versionRow}>
        <div><strong>{t(run.status)}</strong><p>{run.id}</p><small>{new Date(run.createdAt).toLocaleString()}</small>
          {run.error !== null && <p>{run.error}</p>}</div>
        <div className={css.actions}><Button variant="outline" disabled={busy} onClick={() => { void view(run.agentVersionId) }}>{t('versionPrefix')}{run.versionNumber}</Button>
          <Button variant="outline" onClick={() => { props.openRun(run) }}>{t('openRun')}</Button></div>
      </article>)}</div>
    </>}
    {mode !== 'overview' && <div className={css.actions}>{cursor > 0 && <Button variant="outline" disabled={busy || loading} onClick={() => { setCursor(0) }}>{t('first')}</Button>}
      {rows?.nextCursor != null && <Button variant="outline" disabled={busy || loading}
        onClick={() => { if (rows.nextCursor !== null) setCursor(rows.nextCursor) }}>{t('next')}</Button>}</div>}
    {selected !== null && <section className={css.snapshot} aria-label={t('versionSnapshot')}>
      <h2>{t('versionPrefix')}{selected.versionNumber} · {t('versionSnapshot')}</h2>
      <dl><dt>{t('versionId')}</dt><dd>{selected.id}</dd><dt>{t('sourceRevision')}</dt><dd>{selected.sourceRevision}</dd>
        <dt>{t('model')}</dt><dd>{selected.snapshot.model.provider} / {selected.snapshot.model.model}</dd><dt>{t('tools')}</dt><dd>{selected.snapshot.toolIds.join(', ') || t('noTools')}</dd>
        <dt>{t('configHash')}</dt><dd>{selected.configHash}</dd></dl><h3>{t('prompt')}</h3><pre className={css.prompt}>{selected.snapshot.prompt}</pre>
      <details><summary>{t('executionConfig')}</summary><pre className={css.prompt}>{JSON.stringify(selected.snapshot.executionConfig, null, 2)}</pre></details>
    </section>}
    {mode !== 'runs' && <details className={css.deploymentHistory}><summary>{t('deploymentHistory')}</summary>
      {history?.items.length === 0 && <p>{t('notDeployed')}</p>}
      {history?.items.map(item => <div key={item.revision} className={css.versionRow}>
        <span>{t(item.action)} · {item.updatedBy} · {new Date(item.updatedAt).toLocaleString()}</span>
        <Button variant="outline" disabled={busy} onClick={() => { void view(item.versionId) }}>{t('viewVersion')}</Button></div>)}
      <div className={css.actions}>{historyCursor > 0 && <Button variant="outline" onClick={() => { setHistoryCursor(0) }}>{t('first')}</Button>}
        {history?.nextCursor != null && <Button variant="outline"
          onClick={() => { if (history.nextCursor !== null) setHistoryCursor(history.nextCursor) }}>{t('next')}</Button>}</div>
    </details>}
  </section>
}
