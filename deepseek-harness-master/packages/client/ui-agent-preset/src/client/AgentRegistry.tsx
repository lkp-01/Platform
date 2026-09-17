/** Platform resource list, detail and current-draft editor. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefinition, RegistryAgent, RegistryAgentInput, RegistryCatalog, RegistryPage, RegistryQuery } from '@deepseek-ai/dsh-agent-builder/types'
import css from './AgentRegistry.module.css'
import { AgentVersionsPanel, type VersionActions } from './AgentVersions.tsx'

/** Apply-owned transport, shared by all Registry views. */
export interface RegistryActions extends VersionActions {
  catalog(): Promise<RegistryCatalog>
  list(query: RegistryQuery): Promise<RegistryPage>
  get(workspaceId: string, id: string): Promise<RegistryAgent>
  create(workspaceId: string, input: RegistryAgentInput, token: string): Promise<RegistryAgent>
  update(workspaceId: string, id: string, revision: number, input: RegistryAgentInput): Promise<RegistryAgent>
  archive(workspaceId: string, id: string, revision: number, archived: boolean): Promise<RegistryAgent>
}

type Props = RegistryActions & PropsLocale<'agentRegistry'>
type Tab = 'overview' | 'configuration' | 'versions' | 'runs'

function selectedId(): string | null {
  const match = /^#agents\/([a-zA-Z0-9-]+)(?:\/runs\/[a-zA-Z0-9-]+)?$/.exec(window.location.hash)
  return match?.[1] ?? null
}

function editable(value: RegistryAgentInput): RegistryAgentInput {
  return { name: value.name, description: value.description, ownerTeamId: value.ownerTeamId, harnessId: value.harnessId,
    model: { ...value.model }, prompt: value.prompt, toolIds: [...value.toolIds], tags: [...value.tags] }
}

/** Render the resource management panel without creating or observing execution state.
 * @param props - localized transport actions.
 * @returns the list, current resource detail or editable draft.
 */
export function AgentRegistryPanel(props: Props) {
  const { t } = props
  const [catalog, setCatalog] = useState<RegistryCatalog | null>(null)
  const [page, setPage] = useState<RegistryPage | null>(null)
  const [id, setId] = useState<string | null>(selectedId)
  const [agent, setAgent] = useState<RegistryAgent | null>(null)
  const [draft, setDraft] = useState<RegistryAgentInput | null>(null)
  const [tagsText, setTagsText] = useState('')
  const [tab, setTab] = useState<Tab>(window.location.hash.includes('/runs/') ? 'runs' : 'overview')
  const [search, setSearch] = useState('')
  const [lifecycle, setLifecycle] = useState<'active' | 'archived' | 'all'>('active')
  const [cursor, setCursor] = useState<string | undefined>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const token = useRef(randomUUID())
  const actions = useRef(props)
  actions.current = props

  useEffect(() => {
    const changed = () => {
      setId(selectedId()); if (window.location.hash.includes('/runs/')) setTab('runs')
      setDraft(null); setAgent(null); setNotice(null); setRefresh(value => value + 1)
    }
    window.addEventListener('hashchange', changed)
    return () => { window.removeEventListener('hashchange', changed) }
  }, [])

  useEffect(() => {
    let alive = true
    const isAlive = () => alive
    setLoading(true); setError(null)
    void (async () => {
      try {
        const choices = await actions.current.catalog()
        const result = id === null
          ? await actions.current.list({ workspaceId: choices.workspace.id, query: search, lifecycle,
            ...(cursor === undefined ? {} : { cursor }), limit: 24 })
          : await actions.current.get(choices.workspace.id, id)
        if (!isAlive()) return
        setCatalog(choices)
        if ('items' in result) { setPage(result); setAgent(null) } else setAgent(result)
      } catch (failure) { if (isAlive()) setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { if (isAlive()) setLoading(false) }
    })()
    return () => { alive = false }
  }, [id, search, lifecycle, cursor, refresh])

  const navigate = (next: string | null) => {
    window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${next === null ? '#agents' : `#agents/${next}`}`)
    setId(next); setAgent(null); setDraft(null); setTab('overview'); setNotice(null); setError(null)
  }
  const begin = (template?: AgentDefinition) => {
    if (catalog === null) return
    const model = template?.model ?? catalog.models.default
    token.current = randomUUID()
    setTagsText('')
    setDraft({ name: template?.name ?? '', description: '', ownerTeamId: catalog.workspace.ownerTeamId,
      harnessId: 'deepseek-harness', model: { ...model }, prompt: template?.prompt ?? '', toolIds: [...(template?.toolIds ?? [])], tags: [] })
    setError(null); setNotice(null)
  }
  const change = (patch: Partial<RegistryAgentInput>) => {
    token.current = randomUUID()
    setDraft(current => current === null ? null : { ...current, ...patch })
  }
  const save = async () => {
    if (draft === null || catalog === null || busy) return
    setBusy(true); setError(null)
    try {
      const input = { ...draft, tags: tagsText.split(',').map(value => value.trim()).filter(Boolean) }
      const saved = agent === null
        ? await props.create(catalog.workspace.id, input, token.current)
        : await props.update(catalog.workspace.id, agent.id, agent.revision, input)
      navigate(saved.id); setAgent(saved); setNotice(t('saved')); setRefresh(value => value + 1)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const archive = async () => {
    if (agent === null || catalog === null || busy) return
    setBusy(true); setError(null)
    try { setAgent(await props.archive(catalog.workspace.id, agent.id, agent.revision, agent.lifecycle !== 'archived')); setNotice(t('saved')) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const models = catalog?.models.groups.flatMap(group => group.models.map(model => ({ provider: group.id, ...model }))) ?? []
  const modelIndex = draft === null ? -1 : models.findIndex(model =>
    model.provider === draft.model.provider && model.id === draft.model.model)
  const unchangedModel = agent !== null && draft?.model.provider === agent.model.provider && draft.model.model === agent.model.model
  const valid = draft !== null && draft.name.trim().length > 0 && draft.prompt.trim().length > 0 && (modelIndex >= 0 || unchangedModel)
  const owner = catalog?.workspace.ownerTeamName ?? ''
  return <main className={css.panel} aria-label={t('title')}>
    <header className={css.header}><div><div className={css.eyebrow}>{t('workspace')} / {catalog?.workspace.name ?? '—'}</div>
      <h1>{draft !== null ? (agent === null ? t('create') : t('edit')) : id === null ? t('title') : agent?.name ?? t('loading')}</h1>
      <p>{t('subtitle')}</p></div><div className={css.actions}>
      {(id !== null || draft !== null) && <Button variant="outline" disabled={busy} onClick={() => { navigate(null) }}>{t('back')}</Button>}
      {id === null && draft === null && <Button disabled={catalog === null || loading} onClick={() => { begin() }}>{t('create')}</Button>}
    </div></header>
    <p className={css.scope}>{t('shared')}</p>
    {error !== null && <div role="alert" className={css.error}>{error}</div>}
    {notice !== null && <div role="status" className={css.notice}>{notice}</div>}
    {!!catalog?.importErrors.length && <details className={css.error}><summary>{t('importErrors')}</summary>{catalog.importErrors.map(message => <p key={message}>{message}</p>)}</details>}
    {draft !== null ? <form onSubmit={(event) => { event.preventDefault(); if (valid) void save() }}>
      <fieldset disabled={busy} className={css.form}>
        <p className={css.scope}>{t('draftHint')}</p>
        <div className={css.columns}><label>{t('name')}<input aria-label={t('name')} required maxLength={100} value={draft.name} onChange={(event) => { change({ name: event.target.value }) }} /></label>
          <label>{t('owner')}<select value={draft.ownerTeamId} onChange={(event) => { change({ ownerTeamId: event.target.value }) }}><option value={catalog?.workspace.ownerTeamId}>{owner}</option></select></label></div>
        <label>{t('description')}<textarea aria-label={t('description')} rows={2} maxLength={2000} value={draft.description} onChange={(event) => { change({ description: event.target.value }) }} /></label>
        <div className={css.columns}><label>{t('harness')}<select value={draft.harnessId} disabled><option value="deepseek-harness">{t('deepseek')}</option></select></label>
          <label>{t('model')}<select aria-label={t('model')} required={!unchangedModel} value={modelIndex < 0 ? '' : String(modelIndex)} onChange={(event) => {
            const model = models[Number(event.target.value)]
            if (model !== undefined) change({ model: { provider: model.provider, model: model.id } })
          }}><option value="">{unchangedModel ? `${draft.model.model} — ${t('unavailableModel')}` : t('model')}</option>
            {models.map((model, index) => <option key={`${model.provider}/${model.id}`} value={index}>{model.provider} / {model.name}</option>)}</select></label></div>
        {models.length === 0 && <p>{t('noModels')}</p>}
        <label>{t('prompt')}<textarea aria-label={t('prompt')} required rows={9} maxLength={32000} value={draft.prompt} onChange={(event) => { change({ prompt: event.target.value }) }} /></label>
        <label>{t('tags')}<input aria-label={t('tags')} maxLength={819} value={tagsText} onChange={(event) => { setTagsText(event.target.value); token.current = randomUUID() }} /></label>
        <div className={css.toolGrid}>{catalog?.tools.map(tool => <label key={tool.id} className={css.tool}><input type="checkbox" checked={draft.toolIds.includes(tool.id)}
          onChange={(event) => { change({ toolIds: event.target.checked
            ? [...draft.toolIds, tool.id] : draft.toolIds.filter(id => id !== tool.id) }) }} />
        <span><strong>{tool.id}</strong><small>{tool.description}</small></span></label>)}</div>
        <div className={css.actions}><Button variant="outline" onClick={() => { setDraft(null); setError(null) }}>{t('cancel')}</Button>
          {agent !== null && <Button variant="outline" onClick={() => { setDraft(null); setRefresh(value => value + 1) }}>{t('reload')}</Button>}
          <Button type="submit" disabled={!valid}>{busy ? t('saving') : agent === null ? t('create') : t('save')}</Button></div>
        {!valid && <p className={css.scope}>{t('required')}</p>}
      </fieldset>
    </form> : id === null ? <>
      <div className={css.filters}><input aria-label={t('search')} placeholder={t('search')} value={search} onChange={(event) => { setSearch(event.target.value); setCursor(undefined) }} />
        <select aria-label={t('status')} value={lifecycle} onChange={(event) => { setLifecycle(event.target.value as typeof lifecycle); setCursor(undefined) }}>
          <option value="active">{t('active')}</option><option value="archived">{t('archived')}</option><option value="all">{t('all')}</option></select>
        <Button variant="outline" onClick={() => { setRefresh(value => value + 1) }} disabled={loading}>{t('refresh')}</Button></div>
      {loading ? <p role="status">{t('loading')}</p> : <>
        {page?.items.length === 0 && <div className={css.empty}><h2>{t('empty')}</h2><p>{t('emptyHint')}</p></div>}
        <div className={css.cards}>{page?.items.map(item => <article key={item.id} className={css.card} data-agent-id={item.id}>
          <div className={css.cardTop}><span className={css.badge}>{t(item.lifecycle)}</span><span>{t('deepseek')}</span></div>
          <h2><button onClick={() => { navigate(item.id) }}>{item.name}</button></h2><p>{item.description || '—'}</p>
          <dl><dt>{t('owner')}</dt><dd>{owner}</dd><dt>{t('model')}</dt><dd>{item.model.model}</dd><dt>{t('tools')}</dt><dd>{item.toolCount}</dd></dl>
          <Button variant="outline" onClick={() => { navigate(item.id) }}>{t('details')}</Button>
        </article>)}</div>
        <div className={css.actions}>{cursor !== undefined && <Button variant="outline" onClick={() => { setCursor(undefined) }}>{t('first')}</Button>}
          {page?.nextCursor != null && <Button variant="outline" onClick={() => { setCursor(page.nextCursor ?? undefined) }}>{t('next')}</Button>}</div>
      </>}
      <section className={css.templates}><h2>{t('templates')}</h2><div className={css.cards}>{catalog?.agents.map(template => <article key={template.id} className={css.card}>
        <h3>{template.name}</h3><p className={css.excerpt}>{template.prompt}</p><Button variant="outline" onClick={() => { begin(template) }}>{t('useTemplate')}</Button>
      </article>)}</div></section>
    </> : agent !== null ? <>
      <div className={css.actions}><span className={css.badge}>{t(agent.lifecycle)}</span>
        <Button variant="outline" disabled={busy || loading || agent.lifecycle === 'archived'} onClick={() => { setDraft(editable(agent)); setTagsText(agent.tags.join(', ')); setError(null); setNotice(null) }}>{t('edit')}</Button>
        <Button variant="outline" disabled={busy || loading} onClick={() => { void archive() }}>{agent.lifecycle === 'archived' ? t('restore') : t('archive')}</Button>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => { setNotice(t('copied')) }, (failure: unknown) => { setError(String(failure)) }) }}>{t('copiedLink')}</Button></div>
      {agent.lifecycle === 'archived' && <p className={css.scope}>{t('archivedHint')}</p>}
      <nav className={css.tabs} aria-label={t('details')}>{(['overview', 'configuration', 'versions', 'runs'] as const).map(value =>
        <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value) }}>{t(value)}</button>)}</nav>
      {tab === 'overview' && <section className={css.detail}><p>{agent.description || '—'}</p><dl>
        <dt>{t('identifier')}</dt><dd>{agent.id}</dd><dt>{t('owner')}</dt><dd>{owner}</dd><dt>{t('harness')}</dt><dd>{t('deepseek')}</dd>
        <dt>{t('created')}</dt><dd>{new Date(agent.createdAt).toLocaleString()}</dd><dt>{t('updated')}</dt><dd>{new Date(agent.updatedAt).toLocaleString()}</dd>
        <dt>{t('revision')}</dt><dd>{agent.revision}</dd></dl></section>}
      {tab === 'configuration' && <section className={css.detail}><h2>{t('draft')}</h2><p className={css.scope}>{t('draftHint')}</p>
        {agent.legacyPresetId !== null && <p className={css.scope}>{t('legacyHint')}</p>}
        <dl><dt>{t('model')}</dt><dd>{agent.model.provider} / {agent.model.model}</dd><dt>{t('tools')}</dt><dd>{agent.toolIds.join(', ') || t('noTools')}</dd></dl>
        {!models.some(model => model.provider === agent.model.provider && model.id === agent.model.model) && <p>{t('unavailableModel')}</p>}
        {agent.toolIds.some(tool => !catalog?.tools.some(choice => choice.id === tool)) && <p>{t('unavailableTools')}</p>}
        <h3>{t('prompt')}</h3><pre className={css.prompt}>{agent.prompt}</pre></section>}
      {(tab === 'overview' || tab === 'versions' || tab === 'runs') && <AgentVersionsPanel key={agent.id} {...props} agent={agent} mode={tab} />}
    </> : loading ? <p role="status">{t('loading')}</p> : null}
  </main>
}

/** Registry navigation mark, labelled by its sidebar registration. */
export function RegistryIcon() { return <span aria-hidden="true">▦</span> }
