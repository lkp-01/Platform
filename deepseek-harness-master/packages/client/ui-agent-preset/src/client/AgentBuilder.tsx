/** Business Agent library and minimal creation form. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefinition, AgentDefinitionInput } from '@deepseek-ai/dsh-agent-builder/types'
import type { BuilderState } from './builder-store.ts'
import css from './AgentBuilder.module.css'

/** Apply-owned callbacks and dialog snapshot. */
export interface AgentBuilderInjected {
  hooks: { agentBuilder: SnapshotStore<BuilderState> }
  open(): Promise<void>
  close(): void
  refresh(): Promise<void>
  begin(template?: AgentDefinition): void
  change(patch: Partial<AgentDefinitionInput>): void
  back(): void
  save(): Promise<void>
  start(id: string): Promise<void>
}

type Props = InjectFace<AgentBuilderInjected> & PropsLocale<'agentBuilder'>

/**
 * Render the shared Agent library in the shell overlay.
 * @param props - framework-bound state, locale and callbacks.
 * @returns the library and creation modal.
 */
export function AgentBuilder(props: Props) {
  const { t } = props
  const state = props.useAgentBuilder(value => value)
  const catalog = state.catalog
  const draft = state.draft
  const available = catalog?.models.groups.flatMap(group => group.models.map(model => ({ provider: group.id, ...model }))) ?? []
  const modelIndex = available.findIndex(model => model.provider === draft.model.provider && model.id === draft.model.model)
  const valid = draft.name.trim().length > 0 && draft.prompt.trim().length > 0 && modelIndex >= 0
  return <>
    <Modal open={state.open} onClose={props.close} title={state.view === 'list' ? t('library') : t('create')}
      closeLabel={t('close')} description={t('intro')} className={css.dialog as string}>
      {state.error !== null && <div className={css.error} role="alert">{state.error}</div>}
      {state.created !== null && state.view === 'list' && <div className={css.success} role="status">{t('created')}</div>}
      {state.view === 'list' ? <>
        <div className={css.toolbar}>
          <span className={css.caption}>{t('saved')} · {catalog?.agents.length ?? 0}</span>
          <div className={css.actions}>
            <Button variant="outline" disabled={state.busy} onClick={() => { void props.refresh() }}>{state.busy ? t('loading') : t('refresh')}</Button>
            <Button disabled={state.busy || catalog === null} onClick={() => { props.begin() }}>{t('create')}</Button>
          </div>
        </div>
        <div className={css.cards}>{catalog?.agents.map(agent => <article key={agent.id} className={css.card} data-agent-id={agent.id}>
          <span className={css.badge}>{agent.builtin ? t('builtin') : t('custom')}</span>
          <h3>{agent.name}</h3>
          <p className={css.excerpt}>{agent.prompt}</p>
          <div className={css.meta}><span>{agent.model.model}</span><span>{agent.toolIds.length === 0 ? t('zero') : `${agent.toolIds.length} ${t('tools')}`}</span></div>
          <div className={css.actions}>
            <Button variant="outline" disabled={state.busy} onClick={() => { props.begin(agent) }}>{t('template')}</Button>
            <Button disabled={state.busy} onClick={() => { void props.start(agent.id) }}>{t('start')}</Button>
          </div>
        </article>)}</div>
      </> : <form onSubmit={(event) => { event.preventDefault(); if (valid) void props.save() }}>
        <fieldset className={css.form} disabled={state.busy}>
          <div className={css.identity}>
            <label>{t('name')}<input aria-label={t('name')} autoFocus required maxLength={100} value={draft.name} placeholder={t('nameHint')} onChange={(event) => { props.change({ name: event.target.value }) }} /></label>
            <label>{t('model')}<select aria-label={t('model')} required value={modelIndex < 0 ? '' : String(modelIndex)} onChange={(event) => {
              const model = available[Number(event.target.value)]
              if (model !== undefined) props.change({ model: { provider: model.provider, model: model.id } })
            }}><option value="" disabled>{t('model')}</option>{catalog?.models.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model => <option key={model.id} value={String(available.findIndex(item => item.provider === group.id && item.id === model.id))}>{model.name}</option>)}</optgroup>)}</select></label>
          </div>
          {available.length === 0 && <p role="status">{t('noModels')}</p>}
          {!!catalog?.models.failures.length && <p role="status">{t('modelFailures')}</p>}
          <label>{t('prompt')}<textarea aria-label={t('prompt')} required rows={8} maxLength={32000} value={draft.prompt} placeholder={t('promptHint')} onChange={(event) => { props.change({ prompt: event.target.value }) }} /></label>
          <div className={css.toolsHeading}><strong>{t('tools')}</strong><span>{draft.toolIds.length} {t('selected')}</span></div>
          <p className={css.hint}>{t('toolsHint')}</p>
          <div className={css.groups}>{(['customer-service', 'data-analysis', 'operations'] as const).map(group => <section key={group}>
            <h4>{t(group === 'customer-service' ? 'customer' : group === 'data-analysis' ? 'data' : 'operations')}</h4>
            {catalog?.tools.filter(tool => tool.group === group).map(tool => <label key={tool.id} className={css.tool}>
              <input type="checkbox" checked={draft.toolIds.includes(tool.id)} onChange={(event) => { props.change({ toolIds: event.target.checked ? [...draft.toolIds, tool.id] : draft.toolIds.filter(id => id !== tool.id) }) }} />
              <span><strong>{tool.id}</strong><small>{tool.description}</small>{tool.simulatedWrite && <em>{t('simulated')}</em>}</span>
            </label>)}
          </section>)}</div>
          <div className={css.footer}><Button variant="outline" onClick={props.back}>{t('back')}</Button><span className={css.hint}>{!valid && t('requirements')}</span><Button type="submit" disabled={!valid}>{state.busy ? t('creating') : t('create')}</Button></div>
        </fieldset>
      </form>}
    </Modal>
  </>
}

/**
 * Render a compact entry into the shared Agent library.
 * @param props - localized open action from the owning plugin.
 * @returns library button.
 */
export function AgentBuilderEntry(props: PropsLocale<'agentBuilder'> & { open(): Promise<void> }) {
  return <Button variant="outline" onClick={() => { void props.open() }}>{props.t('library')}</Button>
}
