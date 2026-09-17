/** Explicit resource-version selection for Agent drafts. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentResources, ResourceRef, SharedResource } from '@deepseek-ai/dsh-agent-builder/types'
import css from './AgentRegistry.module.css'

/** Select published resources; old selections remain visible when disabled.
 * @param props - current selection, catalog and change callback.
 * @returns model, tool and Skill selectors.
 */
export function ResourcePicker(props: PropsLocale<'agentRegistry'> & { rows: SharedResource[]; value: AgentResources; change: (value: AgentResources) => void }) {
  const { t, value, rows, change } = props
  const options = rows.filter(row => row.spec.kind === 'model').flatMap(row => row.versions.map(version => ({ row, version })))
  const selectedModel = options.find(option => option.version.id === value.model.versionId)
  return <section aria-label={t('resourceBindings')}>
    <h3>{t('resourceBindings')}</h3><p className={css.scope}>{t('resourceBindingHint')}</p>
    <label>{t('model')}<select aria-label={t('model')} value={value.model.versionId} onChange={(event) => {
      const chosen = options.find(option => option.version.id === event.target.value)
      if (chosen !== undefined) change({ ...value, model: { resourceId: chosen.row.id, versionId: chosen.version.id } })
    }}>{options.map(({ row, version }) => <option key={version.id} value={version.id} disabled={row.status !== 'active' && version.id !== value.model.versionId}>
        {row.name}{version.versionNumber === 1 ? '' : ` · v${version.versionNumber}`}{row.status !== 'active' ? ` · ${t(row.status)}` : ''}</option>)}</select></label>
    {selectedModel !== undefined && <small>{t('versions')}: v{selectedModel.version.versionNumber}</small>}
    {(['tools', 'skills'] as const).map(field => <section key={field}><h3>{t(field === 'tools' ? 'tools' : 'resource_skill')}</h3><div className={css.toolGrid}>
      {rows.filter(row => row.spec.kind === (field === 'tools' ? 'tool' : 'skill') && row.versions.length > 0 && (row.status === 'active' || value[field].some(ref => ref.resourceId === row.id))).map((row) => {
        const current = value[field].find(ref => ref.resourceId === row.id)
        const version = row.versions.find(item => item.id === current?.versionId) ?? row.versions.at(-1)
        if (version === undefined) return null
        const select = (ref?: ResourceRef) => {
          change({ ...value, [field]: [...value[field].filter(item => item.resourceId !== row.id), ...(ref === undefined ? [] : [ref])] })
        }
        return <div key={row.id} className={`${css.tool} ${css.resourceChoice}`}><label><input type="checkbox" checked={current !== undefined} onChange={(event) => { select(event.target.checked ? { resourceId: row.id, versionId: version.id } : undefined) }} />
          <span><strong>{row.name}</strong><small>{row.description}</small></span></label>
        <select aria-label={`${row.name} ${t('versions')}`} disabled={current === undefined} value={version.id} onChange={(event) => {
          const next = row.versions.find(item => item.id === event.target.value)
          if (next !== undefined) select({ resourceId: row.id, versionId: next.id })
        }}>{row.versions.map(item => <option key={item.id} value={item.id}>v{item.versionNumber}</option>)}</select>
        {row.status !== 'active' && <small>{t(row.status)}</small>}
        </div>
      })}</div></section>)}
  </section>
}
