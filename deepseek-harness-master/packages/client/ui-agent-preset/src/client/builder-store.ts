/** Shared authoring draft and list state for the business Agent dialog. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AgentBuilderCatalog, AgentDefinition, AgentDefinitionInput } from '@deepseek-ai/dsh-agent-builder/types'

/** Dialog state shared by entry points, with no duplicate Session state. */
export interface BuilderState {
  open: boolean
  view: 'list' | 'create'
  catalog: AgentBuilderCatalog | null
  draft: AgentDefinitionInput
  busy: boolean
  error: string | null
  created: string | null
}

/** Transport and navigation supplied by the plugin's injected services. */
export interface BuilderActions {
  catalog(): Promise<AgentBuilderCatalog>
  create(input: AgentDefinitionInput, token: string): Promise<AgentDefinition>
  start(id: string): Promise<void>
  refreshed(): void
}

/** Owns a submission token until the draft changes, including failed retries. */
export class AgentBuilderController {
  /** Stable snapshot source bound by the slot renderer. */
  readonly store = createSnapshotStore<BuilderState>({
    open: false, view: 'list', catalog: null, draft: { name: '', prompt: '', model: { provider: '', model: '' }, toolIds: [] },
    busy: false, error: null, created: null,
  })
  private token: string | undefined
  constructor(private readonly actions: BuilderActions) {}
  private set(patch: Partial<BuilderState>): void { this.store.set({ ...this.store.getSnapshot(), ...patch }) }

  /** Open the library and refresh configured models and definitions. */
  async open(): Promise<void> {
    this.set({ open: true })
    await this.refresh()
  }

  /** Refresh choices, retaining an unsaved draft on network failure. */
  async refresh(): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.set({ busy: true, error: null })
    try { this.set({ catalog: await this.actions.catalog() }); this.actions.refreshed() }
    catch (error) { this.set({ error: String(error instanceof Error ? error.message : error) }) }
    finally { this.set({ busy: false }) }
  }

  /** Hide the dialog while preserving the draft; active writes cannot be dismissed. */
  close(): void { if (!this.store.getSnapshot().busy) this.set({ open: false }) }

  /**
   * Start a blank form or copy a definition into a new draft.
   * @param template - optional saved Agent whose fields prefill the form.
   */
  begin(template?: AgentDefinition): void {
    if (this.store.getSnapshot().busy) return
    const catalog = this.store.getSnapshot().catalog
    const defaultModel = catalog?.models.default
    const first = catalog?.models.groups[0]
    const model = defaultModel !== undefined && catalog?.models.groups.some(group =>
      group.id === defaultModel.provider && group.models.some(item => item.id === defaultModel.model))
      ? { provider: defaultModel.provider, model: defaultModel.model }
      : { provider: first?.id ?? '', model: first?.models[0]?.id ?? '' }
    this.token = undefined
    this.set({ view: 'create', error: null, created: null, draft: template === undefined
      ? { name: '', prompt: '', model, toolIds: [] }
      : { name: template.name, prompt: template.prompt,
        model: { provider: template.model.provider, model: template.model.model }, toolIds: [...template.toolIds] } })
  }

  /**
   * Update user-owned fields and begin a new submission identity.
   * @param patch - changed form fields.
   */
  change(patch: Partial<AgentDefinitionInput>): void {
    if (this.store.getSnapshot().busy) return
    this.token = undefined
    this.set({ draft: { ...this.store.getSnapshot().draft, ...patch }, error: null })
  }

  /** Return to the library, keeping the current saved result visible. */
  back(): void { if (!this.store.getSnapshot().busy) this.set({ view: 'list', error: null }) }

  /** Save once, showing committed results even if a subsequent refresh would fail. */
  async save(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.busy) return
    this.token ??= randomUUID()
    this.set({ busy: true, error: null })
    try {
      const saved = await this.actions.create(state.draft, this.token)
      const catalog = this.store.getSnapshot().catalog
      this.set({ created: saved.id, view: 'list', ...(catalog === null ? {} : { catalog: { ...catalog, agents: [...catalog.agents.filter(item => item.id !== saved.id), saved] } }) })
      this.actions.refreshed()
    } catch (error) { this.set({ error: String(error instanceof Error ? error.message : error) }) }
    finally { this.set({ busy: false }) }
  }

  /**
   * Start a new Session from the selected immutable definition.
   * @param id - Preset identity from the current list.
   */
  async start(id: string): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.set({ busy: true, error: null })
    try { await this.actions.start(id); this.set({ open: false }) }
    catch (error) { this.set({ error: String(error instanceof Error ? error.message : error) }) }
    finally { this.set({ busy: false }) }
  }
}
