/** Demo resource center for installed model routes, tools and instruction Skills. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RegistryCatalog, ResourceInput, ResourceRef, ResourceStatus, ResourceVersion, ResourceUsage, SharedResource } from '@deepseek-ai/dsh-agent-builder/types'
import css from './AgentRegistry.module.css'

export interface ResourceActions {
  mcpDiscover(ref: ResourceRef): Promise<NonNullable<Extract<ResourceInput['spec'], { kind: 'tool' }>['descriptor']>[]>
  mcpImport(ref: ResourceRef, operation: string, token: string): Promise<SharedResource>
  resourceList(): Promise<SharedResource[]>
  resourceCreate(input: ResourceInput, token: string): Promise<SharedResource>
  resourceUpdate(id: string, revision: number, input: ResourceInput): Promise<SharedResource>
  resourcePublish(id: string, revision: number, token: string): Promise<ResourceVersion>
  resourceStatus(id: string, revision: number, status: ResourceStatus): Promise<SharedResource>
  resourceUsage(id: string): Promise<ResourceUsage[]>
  catalog(): Promise<RegistryCatalog>
}
type Props = ResourceActions & PropsLocale<'agentRegistry'>
function inputOf(row: SharedResource): ResourceInput {
  return { name: row.name, description: row.description, ownerTeamId: row.ownerTeamId, spec: row.spec }
}

/** Resource administration uses the shared demo Host and carries no identity or credential fields.
 * @param props - locale and narrow Remote callbacks.
 * @returns resource directory and selected editor.
 */
export function SharedResourcesPanel(props: Props) {
  const { t } = props
  const actions = useRef(props); actions.current = props
  const [rows, setRows] = useState<SharedResource[]>([])
  const [catalog, setCatalog] = useState<RegistryCatalog | null>(null)
  const [selected, setSelected] = useState<SharedResource | null>(null)
  const [draft, setDraft] = useState<ResourceInput | null>(null)
  const [usage, setUsage] = useState<ResourceUsage[]>([])
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [discovered, setDiscovered] = useState<Awaited<ReturnType<ResourceActions['mcpDiscover']>>>([])
  const [serverVersion, setServerVersion] = useState('')
  const token = useRef(randomUUID())
  const publishToken = useRef(randomUUID())
  const selection = useRef(0)
  useEffect(() => {
    let alive = true
    void Promise.all([actions.current.resourceList(), actions.current.catalog()]).then(([resources, choices]) => {
      if (alive) { setRows(resources); setCatalog(choices); setReady(true) }
    }, (failure: unknown) => { if (alive) setError(String(failure)) })
    return () => { alive = false }
  }, [])
  const open = async (row: SharedResource) => {
    const request = ++selection.current
    setSelected(row); setDraft(inputOf(row)); setUsage([]); setError(null); publishToken.current = randomUUID()
    setDiscovered([]); setServerVersion(row.versions.at(-1)?.id ?? '')
    try { const users = await props.resourceUsage(row.id); if (selection.current === request) setUsage(users) }
    catch (failure) { if (selection.current === request) setError(String(failure)) }
  }
  const operate = async (action: () => Promise<SharedResource | void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const saved = await action()
      const resources = await props.resourceList(); setRows(resources)
      const current = saved ?? resources.find(row => row.id === selected?.id)
      if (current !== undefined) await open(current)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const change = (patch: Partial<ResourceInput>) => {
    token.current = randomUUID(); setDraft(current => current === null ? null : { ...current, ...patch })
  }
  const create = () => {
    selection.current++; setSelected(null); setUsage([]); token.current = randomUUID(); setError(null)
    setDraft({ name: '', description: '', ownerTeamId: catalog?.workspace.ownerTeamId ?? 'shared-team', spec: { kind: 'skill', content: '' } })
  }
  const models = catalog?.models.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, label: `${group.id} / ${model.name}` }))) ?? []
  const modelSpec = draft?.spec.kind === 'model' ? draft.spec : null
  const modelIndex = models.findIndex(model => model.provider === modelSpec?.provider && model.model === modelSpec.model)
  const dirty = draft !== null && selected !== null && JSON.stringify(draft) !== JSON.stringify(inputOf(selected))
  return <main className={css.panel} aria-label={t('resourcesTitle')}>
    <header className={css.header}><div><div className={css.eyebrow}>{t('workspace')} / {catalog?.workspace.name ?? '—'}</div>
      <h1>{t('resourcesTitle')}</h1><p>{t('resourcesSubtitle')}</p></div><div className={css.actions}>{draft !== null && <Button variant="outline" disabled={busy} onClick={() => { selection.current++; setDraft(null); setSelected(null) }}>{t('resourceBack')}</Button>}
      <Button disabled={!ready || busy} onClick={create}>{t('resourceCreate')}</Button></div></header>
    {error !== null && <p role="alert" className={css.error}>{error}</p>}
    <div className={css.filters}><input aria-label={t('resourceSearch')} placeholder={t('resourceSearch')} value={filter} onChange={(event) => { setFilter(event.target.value) }} />
      <select aria-label={t('resourceKind')} value={kind} onChange={(event) => { setKind(event.target.value) }}>
        <option value="all">{t('all')}</option>{(['model', 'tool', 'skill', 'mcp-server', 'credential'] as const).map(value => <option key={value} value={value}>{t(`resource_${value}`)}</option>)}</select>
      <Button variant="outline" disabled={busy} onClick={() => { void operate(async () => {}) }}>{t('refresh')}</Button></div>
    {!ready && <p>{t('loading')}</p>}
    {draft === null && <div className={css.cards}>{rows.filter(row => (kind === 'all' || row.spec.kind === kind) && `${row.name} ${row.ownerTeamId}`.toLowerCase().includes(filter.toLowerCase())).map(row =>
      <article className={css.card} key={row.id} data-resource={row.id}><div className={css.cardTop}><span>{t(`resource_${row.spec.kind}`)}</span><span className={css.badge}>{t(row.status)}</span></div>
        <h2><button disabled={busy} onClick={() => { void open(row) }}>{row.name}</button></h2><p>{row.description}</p>
        <small>{row.ownerTeamId} · {row.versions.length === 0 ? t('resourceUnpublished') : `${t('resourceVersionPrefix')}${row.versions.at(-1)?.versionNumber}`}</small></article>)}</div>}
    {draft !== null && <section className={css.detail} aria-label={t('resourceEditor')}><h2>{selected?.name ?? t('resourceCreate')}</h2>
      <form onSubmit={(event) => { event.preventDefault()
        void operate(() => selected === null ? props.resourceCreate(draft, token.current)
          : props.resourceUpdate(selected.id, selected.revision, draft)) }}>
        <fieldset className={css.form} disabled={busy}>
          <div className={css.columns}><label>{t('name')}<input aria-label={t('name')} required maxLength={100} value={draft.name} onChange={(event) => { change({ name: event.target.value }) }} /></label>
            <label>{t('owner')}<input aria-label={t('owner')} required maxLength={100} value={draft.ownerTeamId} onChange={(event) => { change({ ownerTeamId: event.target.value }) }} /></label></div>
          <label>{t('description')}<textarea aria-label={t('description')} maxLength={2000} value={draft.description} onChange={(event) => { change({ description: event.target.value }) }} /></label>
          <label>{t('resourceKind')}<select aria-label={t('resourceKind')} disabled={selected !== null} value={draft.spec.kind} onChange={(event) => {
            const value = event.target.value
            change({ spec: value === 'skill' ? { kind: 'skill', content: '' } : value === 'tool' ? { kind: 'tool', operation: catalog?.tools[0]?.id ?? '' }
              : value === 'mcp-server' ? { kind: 'mcp-server', url: '', transport: 'streamable-http' }
                : value === 'credential' ? { kind: 'credential', alias: '' }
                  : { kind: 'model', provider: models[0]?.provider ?? '', model: models[0]?.model ?? '' } })
          }}>{(['model', 'tool', 'skill', 'mcp-server', 'credential'] as const).map(value => <option key={value} value={value}>{t(`resource_${value}`)}</option>)}</select></label>
          {draft.spec.kind === 'credential' && <label>{t('mcpCredential')}<input value={draft.spec.alias} onChange={(event) => { change({ spec: { kind: 'credential', alias: event.target.value } }) }} /></label>}
          {draft.spec.kind === 'mcp-server' && <>
            <label>{t('mcpTransport')}<select value={draft.spec.transport ?? 'streamable-http'} onChange={(event) => {
              if (draft.spec.kind !== 'mcp-server') return
              const { url: _url, launchProfile: _profile, ...base } = draft.spec
              change({ spec: event.target.value === 'stdio' ? { ...base, transport: 'stdio', launchProfile: '' }
                : { ...base, transport: 'streamable-http', url: '' } })
            }}><option value="streamable-http">{t('mcpHttp')}</option><option value="stdio">{t('mcpStdio')}</option></select></label>
            <label>{draft.spec.transport === 'stdio' ? t('mcpProfile') : t('mcpEndpoint')}<input required value={draft.spec.transport === 'stdio' ? draft.spec.launchProfile ?? '' : draft.spec.url ?? ''} onChange={(event) => {
              if (draft.spec.kind === 'mcp-server') change({ spec: { ...draft.spec, ...(draft.spec.transport === 'stdio' ? { launchProfile: event.target.value } : { url: event.target.value }) } })
            }} /></label>
            <label>{t('mcpCredential')}<select value={draft.spec.credential?.versionId ?? ''} onChange={(event) => {
              if (draft.spec.kind !== 'mcp-server') return
              const row = rows.find(row => row.spec.kind === 'credential' && row.versions.some(version => version.id === event.target.value))
              const version = row?.versions.find(version => version.id === event.target.value)
              const { credential: _credential, ...base } = draft.spec
              change({ spec: row === undefined || version === undefined ? base
                : { ...base, credential: { resourceId: row.id, versionId: version.id } } })
            }}><option value="">{t('mcpNoCredential')}</option>{rows.filter(row => row.spec.kind === 'credential' && row.status === 'active').flatMap(row => row.versions.map(version => <option key={version.id} value={version.id}>{row.name} · {version.versionNumber}</option>))}</select></label>
          </>}
          {draft.spec.kind === 'skill' && <label>{t('skillContent')}<textarea aria-label={t('skillContent')} required rows={8} maxLength={16000} value={draft.spec.content} onChange={(event) => { change({ spec: { kind: 'skill', content: event.target.value } }) }} /></label>}
          {draft.spec.kind === 'tool' && draft.spec.server !== undefined && <pre className={css.prompt}>{JSON.stringify(draft.spec.descriptor ?? draft.spec, null, 2)}</pre>}
          {draft.spec.kind === 'tool' && draft.spec.server === undefined && <label>{t('toolOperation')}<select aria-label={t('toolOperation')} value={draft.spec.operation} onChange={(event) => { change({ spec: { kind: 'tool', operation: event.target.value } }) }}>
            {catalog?.tools.map(tool => <option key={tool.id} value={tool.id}>{tool.id}</option>)}</select></label>}
          {draft.spec.kind === 'model' && <label>{t('model')}<select aria-label={t('model')} required value={modelIndex < 0 ? '' : modelIndex} onChange={(event) => {
            const model = models[Number(event.target.value)]; if (model !== undefined) change({ spec: { kind: 'model', provider: model.provider, model: model.model } })
          }}><option value="">{t('model')}</option>{models.map((model, index) => <option key={index} value={index}>{model.label}</option>)}</select></label>}
          <p className={css.scope}>{t('resourcePublishHint')}</p><div className={css.actions}><Button type="submit">{t('save')}</Button>
            {selected !== null && <Button disabled={dirty || selected.status !== 'active'} onClick={() => { void operate(async () => { await props.resourcePublish(selected.id, selected.revision, publishToken.current) }) }}>{t('resourcePublish')}</Button>}</div>
        </fieldset>
      </form>
      {selected?.spec.kind === 'mcp-server' && <section><label>{t('versions')}<select disabled={busy} value={serverVersion} onChange={(event) => { setServerVersion(event.target.value); setDiscovered([]) }}>
        {selected.versions.map(version => <option key={version.id} value={version.id}>{t('resourceVersionPrefix')}{version.versionNumber}</option>)}</select></label>
      <Button disabled={busy || !serverVersion} onClick={() => { void (async () => {
        const version = selected.versions.find(version => version.id === serverVersion)
        if (version === undefined) return
        setBusy(true); setError(null)
        try { setDiscovered(await props.mcpDiscover({ resourceId: selected.id, versionId: version.id })) }
        catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      })() }}>{t('mcpDiscover')}</Button>
      {discovered.map(tool => <article key={tool.name}><h3>{tool.name}</h3><p>{tool.description}</p>
        <pre className={css.prompt}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        <Button disabled={busy} onClick={() => { void operate(async () => {
          const version = selected.versions.find(version => version.id === serverVersion)
          if (version !== undefined) return props.mcpImport({ resourceId: selected.id, versionId: version.id }, tool.name, randomUUID())
        }) }}>{t('mcpImport')}</Button></article>)}
      </section>}
      {selected !== null && <><label>{t('status')}<select aria-label={t('status')} disabled={busy} value={selected.status} onChange={(event) => { void operate(() => props.resourceStatus(selected.id, selected.revision, event.target.value as ResourceStatus)) }}>
        {(['active', 'deprecated', 'disabled', 'archived'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
      <h3>{t('versions')}</h3>{selected.versions.slice().reverse().map(version => <details key={version.id}><summary>{`${t('resourceVersionPrefix')}${version.versionNumber}`} · {new Date(version.createdAt).toLocaleString()}</summary>
        <pre className={css.prompt}>{JSON.stringify(version.spec, null, 2)}</pre><small>{version.specHash}</small></details>)}
      <h3>{t('resourceUsage')}</h3>{usage.length === 0 ? <p>{t('resourceUnused')}</p> : usage.map((use, index) => <p key={index}>
        <a href={`#agents/${use.agentId}`}>{use.agentName}</a> · {use.versionNumber === null ? t('draft') : `${t('resourceVersionPrefix')}${use.versionNumber}`} {use.deployed && t('deployed')}</p>)}</>}
    </section>}
  </main>
}
