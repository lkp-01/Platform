/** Form-based Agent authoring over the official Preset registry. */
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load, JSON_SCHEMA } from 'js-yaml'
import { ZodError } from 'zod'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { TOOL_CHOICES, definitionId, inputSchema, parseDefinition, tokenSchema } from './definition.ts'
import { publishDefinition } from './authoring.ts'
import { AgentRegistry, registryInputSchema, RegistryError } from './registry.ts'
import { AgentVersions } from './versions.ts'
import { AgentDeployments } from './deployments.ts'
import { PlatformRuns, versionCallConfig } from './platform-runs.ts'
import { PlatformTraces } from './platform-traces.ts'
import type { RunTrace, RunTracePage } from './trace-types.ts'
import { prepareVersionPreset } from './version-preset.ts'
import type { AgentVersion, AgentVersionSummary, AgentDeployment, AgentHistoryPage, PlatformRun, RunStatus } from './types.ts'
import type { AgentBuilderCatalog, AgentDefinition, AgentDefinitionInput, RegistryAgent, RegistryAgentInput, RegistryCatalog, RegistryPage, RegistryQuery } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentBuilder: AgentBuilder }
}

/** Host-owned configuration directory. */
interface Config {
  /** Maximum Unicode code points retained in each Trace preview. */
  tracePreviewChars?: number
  /** Host-owned persistent directory, also included in Preset discovery. */
  root: string
  /** Organization workspace ID; independent of filesystem workspaces. */
  workspaceId?: string
  /** Human-readable organization workspace name. */
  workspaceName?: string
  /** Host-owned team identity in this shared deployment. */
  ownerTeamId?: string
  /** Human-readable owner team name. */
  ownerTeamName?: string
}

/** Creates immutable business definitions without accepting composition code. */
export default class AgentBuilder extends TypertRemoteService {
  static inject = ['agentPresets', 'sessionController', 'llm', 'agentDefaultModel', 'storageDomain', 'agents', 'sessions', 'sessionQuery']
  static Config: s<Config> = s.object({ root: s.string().required(),
    tracePreviewChars: s.number().min(64).max(16000).step(1).default(4000),
    workspaceId: s.string().default('shared'), workspaceName: s.string().default('Shared workspace'),
    ownerTeamId: s.string().default('shared-team'), ownerTeamName: s.string().default('Shared team'),
  })
  private registry!: AgentRegistry
  private versions!: AgentVersions
  private deployments!: AgentDeployments
  private runs!: PlatformRuns
  private traces!: PlatformTraces
  private readonly stores: { close(): Promise<void> }[] = []
  private importErrors: string[] = []

  protected async [Service.init](): Promise<void> {
    this.registry = await AgentRegistry.open(this.ctx.storageDomain, {
      id: this.config.workspaceId ?? 'shared', name: this.config.workspaceName ?? 'Shared workspace',
      ownerTeamId: this.config.ownerTeamId ?? 'shared-team', ownerTeamName: this.config.ownerTeamName ?? 'Shared team', accessMode: 'shared-host',
    })
    this.ctx.effect(() => async () => {
      for (const store of this.stores.toReversed()) await store.close()
      await this.registry.close()
    }, 'agent-builder.storage-close')
    this.versions = await AgentVersions.open(this.ctx.storageDomain, this.registry)
    this.stores.push(this.versions)
    this.deployments = await AgentDeployments.open(this.ctx.storageDomain, this.registry, this.versions)
    this.stores.push(this.deployments)
    this.runs = await PlatformRuns.open(this.ctx, this.registry, this.versions, this.deployments)
    this.stores.push(this.runs)
    this.traces = await PlatformTraces.open(this.ctx, this.runs, this.config.tracePreviewChars ?? 4000)
    this.stores.splice(this.stores.length - 1, 0, this.traces)
    let entries: string[]
    try { entries = await readdir(this.config.root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = [] }
    for (const id of entries.filter(value => /^agent-[a-f0-9]{32}$/.test(value))) {
      try {
        const value = parseDefinition(await readFile(resolve(this.config.root, id, 'agent.cordis.yml'), 'utf8'))
        if (definitionId(value.requestToken) !== id) throw new Error('Preset identity mismatch')
        await this.registry.create(this.registry.workspace.id, this.resourceInput(value), value.requestToken, id, 'migration')
      } catch (error) { this.importErrors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  private resourceInput(input: AgentDefinitionInput): RegistryAgentInput {
    return { name: input.name, prompt: input.prompt, model: input.model, toolIds: input.toolIds,
      description: '', tags: [], ownerTeamId: this.registry.workspace.ownerTeamId, harnessId: 'deepseek-harness' }
  }

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'agentBuilder')
    ctx.on('api-session/initial-model', async (preset, next) => {
      const inherited = await next()
      const version = preset === undefined ? undefined : this.versions.find(preset)
      if (version !== undefined) return versionCallConfig(version)
      if (preset === undefined || !preset.startsWith('agent-')) return inherited
      const resolved = await ctx.agentPresets.resolve(preset)
      if (resolve(resolved.path) !== resolve(config.root, preset, 'agent.cordis.yml')) return inherited
      const resource = this.registry.get(this.registry.workspace.id, preset)
      if (resource.lifecycle === 'archived') throw new RegistryError('archived', 'Restore this Agent before starting a new conversation')
      return (await this.get(preset)).model
    })
    ctx.on('api-session/authorize', (request) => {
      if (request.action === 'create' && request.agentPreset?.startsWith('version-')) {
        this.runs.assertCreation(request.sessionId, request.agentPreset)
      } else if (request.action !== 'create' && this.runs.forSession(request.sessionId) !== undefined) {
        throw new RemoteError('agent-version/invalid', 'This versioned Run is immutable; start a new task from its Agent', {})
      }
      return Promise.resolve()
    })
    ctx.on('agent-presets/authorize', (request) => {
      if (request.presetId.startsWith('version-') || (request.agent !== undefined && this.runs.forSession(request.agent.session.id) !== undefined)) {
        throw new RemoteError('agent-version/invalid', 'Managed version compositions are immutable; use Agent Versions and Runs', {})
      }
      return Promise.resolve()
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const inherited = await next()
      const run = this.runs.forSession(agent.session.id)
      return run === undefined ? inherited : versionCallConfig(this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId))
    })
  }

  /**
   * Read templates and saved Agents together with currently configured models.
   * @returns current authoring choices without creating a Session.
   */
  @Remote('catalog')
  async catalog(): Promise<AgentBuilderCatalog> {
    const models = await this.ctx.sessionController.modelCatalog()
    const agents: AgentDefinition[] = []
    for (const preset of await this.ctx.agentPresets.list()) {
      if (['customer-service', 'data', 'operations'].includes(preset.id)
        || resolve(preset.path) === resolve(this.config.root, preset.id, 'agent.cordis.yml')) agents.push(await this.get(preset.id))
    }
    return { models, tools: TOOL_CHOICES, agents }
  }

  /**
   * Project one trusted template or immutable managed definition.
   * @param id - id selected from the Preset roster.
   * @returns editable business fields and identity.
   */
  @Remote('get')
  async get(id: string): Promise<AgentDefinition> {
    const preset = await this.ctx.agentPresets.resolve(id)
    const text = await readFile(preset.path, 'utf8')
    if (resolve(preset.path) === resolve(this.config.root, id, 'agent.cordis.yml')) {
      const { requestToken, ...value } = parseDefinition(text)
      if (definitionId(requestToken) !== id) throw new Error('Saved Agent identity does not match its submission')
      return { ...value, id: definitionId(requestToken), builtin: false }
    }
    if (!['customer-service', 'data', 'operations'].includes(id)) throw new RemoteError('gateway/bad-request', 'Not a business Agent template', {})
    const rows = load(text, { schema: JSON_SCHEMA }) as { id: string; config?: { prefix?: string } }[]
    const prompt = rows.find(row => row.id === 'persona')?.config?.prefix
    if (typeof prompt !== 'string') throw new Error('Template has no role prompt')
    const group = id === 'data' ? 'data-analysis' : id
    return { id: brandString<AgentDefinition['id']>(id), name: preset.name ?? id, prompt,
      model: this.ctx.agentDefaultModel.currentSelection(),
      toolIds: TOOL_CHOICES.filter(tool => tool.group === group).map(tool => tool.id), builtin: true }
  }

  /**
   * Validate and persist a definition; repeated identical submissions return it.
   * @param input - business fields from the form.
   * @param requestToken - stable UUID for retries of this submission.
   * @returns saved Agent identity and fields.
   */
  @Remote('create')
  async create(input: AgentDefinitionInput, requestToken: string): Promise<AgentDefinition> {
    const parsed = inputSchema.safeParse(input)
    const token = tokenSchema.safeParse(requestToken)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', parsed.error.message, {})
    if (!token.success) throw new RemoteError('gateway/bad-request', token.error.message, {})
    const catalog = await this.ctx.sessionController.modelCatalog()
    if (!catalog.groups.some(group => group.id === parsed.data.model.provider
      && group.models.some(model => model.id === parsed.data.model.model))) {
      throw new RemoteError('session/model-unavailable', 'Choose a model from the available catalog', parsed.data.model)
    }
    await this.ctx.llm.resolveCallConfig(parsed.data.model)
    await this.registry.create(this.registry.workspace.id, this.resourceInput(parsed.data), token.data, definitionId(token.data))
    return publishDefinition(this.config.root, { ...parsed.data, requestToken: token.data })
  }

  /** Read templates and choices for the configured shared workspace.
   * @returns catalog with explicit access scope and import failures.
   */
  @Remote('registryCatalog')
  async registryCatalog(): Promise<RegistryCatalog> {
    const models = await this.ctx.sessionController.modelCatalog()
    const agents = await Promise.all(['customer-service', 'data', 'operations'].map(id => this.get(id)))
    return { models, agents, tools: TOOL_CHOICES, workspace: this.registry.workspace, importErrors: this.importErrors }
  }

  /** List summaries without materializing Prompt bodies.
   * @param query - workspace, filters and pagination.
   * @returns bounded resource page.
   */
  @Remote('registryList')
  async registryList(query: RegistryQuery): Promise<RegistryPage> { return this.registryCall(() => this.registry.list(query)) }

  /** Read current metadata and draft.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @returns current resource including archived state.
   */
  @Remote('registryGet')
  async registryGet(workspaceId: string, id: string): Promise<RegistryAgent> {
    return this.registryCall(() => this.registry.get(workspaceId, id))
  }

  /** Save a resource without publishing or executing it.
   * @param workspaceId - organization scope.
   * @param input - metadata and current configuration.
   * @param requestToken - stable retry token.
   * @returns durable resource.
   */
  @Remote('registryCreate')
  async registryCreate(workspaceId: string, input: RegistryAgentInput, requestToken: string): Promise<RegistryAgent> {
    return this.registryCall(async () => {
      this.registry.list({ workspaceId, limit: 1 })
      const value = registryInputSchema.parse(input)
      await this.validateModel(value)
      return this.registry.create(workspaceId, value, requestToken)
    })
  }

  /** Save the draft under its loaded revision, preserving executed Presets.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @param revision - optimistic edit lock.
   * @param input - replacement fields.
   * @returns updated resource.
   */
  @Remote('registryUpdate')
  async registryUpdate(workspaceId: string, id: string, revision: number, input: RegistryAgentInput): Promise<RegistryAgent> {
    return this.registryCall(async () => {
      const current = this.registry.get(workspaceId, id)
      const value = registryInputSchema.parse(input)
      if (value.model.provider !== current.model.provider || value.model.model !== current.model.model) await this.validateModel(value)
      return this.registry.update(workspaceId, id, revision, value)
    })
  }

  /** Set lifecycle without removing historical Sessions or Presets.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @param revision - optimistic edit lock.
   * @param archived - true to archive, false to restore.
   * @returns committed resource.
   */
  @Remote('registryArchive')
  async registryArchive(workspaceId: string, id: string, revision: number, archived: boolean): Promise<RegistryAgent> {
    return this.registryCall(() => this.registry.setArchived(workspaceId, id, revision, archived))
  }

  /** Save the selected draft revision without deploying it.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param revision - saved draft revision.
   * @param token - stable request UUID.
   * @param note - change description.
   * @returns immutable configuration version.
   */
  @Remote('versionCreate')
  async versionCreate(workspaceId: string, id: string, revision: number, token: string, note: string): Promise<AgentVersion> {
    return this.registryCall(() => this.versions.create(workspaceId, id, revision, token, note, async (draft) => {
      inputSchema.parse({ name: draft.name, prompt: draft.prompt, model: draft.model, toolIds: draft.toolIds })
      await this.validateModel(draft)
      return this.ctx.llm.resolveCallConfig({ provider: draft.model.provider, model: draft.model.model })
    }))
  }

  /** List historical version summaries.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param cursor - zero-based page offset.
   * @returns bounded version metadata.
   */
  @Remote('versionList')
  async versionList(workspaceId: string, id: string, cursor: number): Promise<AgentHistoryPage<AgentVersionSummary>> {
    return this.registryCall(() => this.versions.list(workspaceId, id, cursor))
  }

  /** Read an immutable snapshot, even if its dependencies are unavailable.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param versionId - exact version identity.
   * @returns complete saved configuration.
   */
  @Remote('versionGet')
  async versionGet(workspaceId: string, id: string, versionId: string): Promise<AgentVersion> {
    return this.registryCall(() => this.versions.get(workspaceId, id, versionId))
  }

  /** Read the current default deployment.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @returns activation or null before first deployment.
   */
  @Remote('deploymentGet')
  async deploymentGet(workspaceId: string, id: string): Promise<AgentDeployment | null> {
    return this.registryCall(() => this.deployments.get(workspaceId, id))
  }

  /** Read deployment and rollback history.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param cursor - page offset.
   * @returns bounded activation history.
   */
  @Remote('deploymentHistory')
  async deploymentHistory(workspaceId: string, id: string, cursor: number): Promise<AgentHistoryPage<AgentDeployment>> {
    return this.registryCall(() => this.deployments.history(workspaceId, id, cursor))
  }

  /** Activate a saved version for future tasks only.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param versionId - target snapshot.
   * @param revision - expected deployment revision, initially zero.
   * @param token - stable request UUID.
   * @param action - deploy or rollback intent.
   * @returns committed activation.
   */
  @Remote('deploymentActivate')
  async deploymentActivate(
    workspaceId: string, id: string, versionId: string, revision: number, token: string, action: 'deploy' | 'rollback',
  ): Promise<AgentDeployment> {
    return this.registryCall(() => this.deployments.activate(
      workspaceId, id, versionId, revision, token, action, version => this.prepareVersion(version),
    ))
  }

  /** Accept a task against the currently deployed version.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param prompt - task input.
   * @param token - stable admission UUID.
   * @returns task attribution and current status.
   */
  @Remote('runStart')
  async runStart(workspaceId: string, id: string, prompt: string, token: string): Promise<PlatformRun> {
    return this.registryCall(() => this.runs.start(workspaceId, id, prompt, token, version => this.prepareVersion(version)))
  }

  /** List real platform tasks, independently of legacy Sessions.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param cursor - page offset.
   * @param versionId - optional exact version filter.
   * @param status - optional lifecycle filter.
   * @returns bounded Run page.
   */
  @Remote('runList')
  async runList(
    workspaceId: string, id: string, cursor: number, versionId?: string, status?: RunStatus,
  ): Promise<AgentHistoryPage<PlatformRun>> {
    return this.registryCall(() => this.runs.list(workspaceId, id, cursor, versionId, status))
  }

  /** Read a Run with the version selected at admission.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @returns attribution and Harness-derived status.
   */
  @Remote('runGet')
  async runGet(workspaceId: string, id: string, runId: string): Promise<PlatformRun> {
    return this.registryCall(() => this.runs.get(workspaceId, id, runId))
  }

  /** Read execution accounting for an authorized task.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @returns persisted Trace summary and availability.
   */
  @Remote('runTraceGet')
  async runTraceGet(workspaceId: string, id: string, runId: string): Promise<RunTrace> {
    return this.registryCall(async () => this.traces.get(await this.runs.get(workspaceId, id, runId)))
  }

  /** Read source-ordered execution facts with bounded previews.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @param cursor - opaque position from a previous page.
   * @param limit - maximum events, from 1 to 100.
   * @returns events and the matching accounting revision.
   */
  @Remote('runTraceEvents')
  async runTraceEvents(workspaceId: string, id: string, runId: string, cursor?: string, limit?: number): Promise<RunTracePage> {
    return this.registryCall(async () => this.traces.events(await this.runs.get(workspaceId, id, runId), cursor, limit))
  }

  /** Request cancellation of a scoped platform task.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @returns current lifecycle, including pending cancellation intent.
   */
  @Remote('runCancel')
  async runCancel(workspaceId: string, id: string, runId: string): Promise<PlatformRun> {
    return this.registryCall(() => this.runs.cancel(workspaceId, id, runId))
  }

  /** Resolve a managed Session for the execution-page cancellation entry.
   * @param sessionId - existing Session identity.
   * @returns task after checking its configured organization scope.
   */
  @Remote('runForSession')
  async runForSession(sessionId: string): Promise<PlatformRun> {
    return this.registryCall(() => {
      const run = this.runs.forSession(sessionId)
      if (run === undefined) throw new RegistryError('not-found', 'Run not found')
      return this.runs.get(this.registry.workspace.id, run.agentId, run.id)
    })
  }

  private async prepareVersion(version: AgentVersion): Promise<void> {
    const input = { name: version.id, prompt: version.snapshot.prompt, model: version.snapshot.model, toolIds: version.snapshot.toolIds }
    inputSchema.parse(input)
    await this.validateModel(input)
    await this.ctx.llm.resolveCallConfig(versionCallConfig(version))
    await prepareVersionPreset(this.config.root, version)
    await this.ctx.agentPresets.standingKeyFor(version.id)
  }

  private async registryCall<T>(action: () => T | Promise<T>): Promise<T> {
    try { return await action() }
    catch (error) {
      if (error instanceof RegistryError) throw new RemoteError(`agent-registry/${error.code}`, error.message, {})
      if (error instanceof ZodError) throw new RemoteError('agent-registry/validation', error.issues.map(issue => issue.message).join('; '), {})
      throw error
    }
  }

  private async validateModel(input: AgentDefinitionInput): Promise<void> {
    const catalog = await this.ctx.sessionController.modelCatalog()
    if (!catalog.groups.some(group => group.id === input.model.provider && group.models.some(model => model.id === input.model.model))) {
      throw new RemoteError('session/model-unavailable', 'Choose a model from the available catalog', input.model)
    }
    await this.ctx.llm.resolveCallConfig({ provider: input.model.provider, model: input.model.model })
  }
}
