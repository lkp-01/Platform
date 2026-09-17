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
import { runtimePolicySchema, type RuntimePolicy } from './runtime-policy.ts'
import { Governance, GovernanceError, type WorkspaceAction } from './governance.ts'
import { currentPrincipal, platformActor } from './principal-context.ts'
import { mountPlatformHttp } from './platform-http.ts'
import { SharedResources } from './shared-resources.ts'
import { resourceInputSchema } from './resource-schema.ts'
import type { ResourceInput, ResourceStatus, ResourceVersion, SharedResource, ResourceUsage, ResourceManifest,
  AgentResources } from './resource-types.ts'
import { PlatformTraces } from './platform-traces.ts'
import { PlatformObservability } from './platform-observability.ts'
import { validatePrices } from './observability-pricing.ts'
import { observationQuerySchema } from './observability-schema.ts'
import type { ObservationQuery, ObservationReport, ObservationRunPage } from './observability-types.ts'
import type { RunTrace, RunTracePage } from './trace-types.ts'
import { prepareVersionPreset } from './version-preset.ts'
import type { AgentVersion, AgentVersionSummary, AgentDeployment, AgentHistoryPage, PlatformRun, RunStatus } from './types.ts'
import type { AgentBuilderCatalog, AgentDefinition, AgentDefinitionInput, RegistryAgent, RegistryAgentInput,
  RegistryCatalog, RegistryPage, RegistryQuery } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentBuilder: AgentBuilder }
}

/** Host-owned configuration directory. */
interface Config {
  /** Operator JSON price versions; rates use micro currency units per million tokens. */
  observabilityPricesFile?: string
  /** Delay between background analytics reconciliation passes. */
  observabilityRefreshMs?: number
  /** Operator-owned JSON file with user credential hashes and bootstrap workspaces. */
  governanceFile?: string
  /** Durable execution budgets and explicit adapter replay declarations. */
  runtime?: Partial<RuntimePolicy>
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
  static inject = ['agentPresets', 'sessionController', 'llm', 'agentDefaultModel', 'storageDomain', 'agents', 'sessions',
    'sessionQuery', 'tools', 'sessionPersistence']
  static Config: s<Config> = s.object({ governanceFile: s.string(), root: s.string().required(),
    observabilityPricesFile: s.string(), observabilityRefreshMs: s.number().min(20).max(60000).step(1).default(1000),
    runtime: s.object({
      concurrency: s.number().min(1).max(64).step(1).default(4),
      pollMs: s.number().min(20).max(60000).step(1).default(1000),
      checkpointMs: s.number().min(100).max(60000).step(1).default(5000),
      maxAttempts: s.number().min(1).max(100).step(1).default(5),
      deadlineMs: s.number().min(1000).max(604800000).step(1).default(86400000),
      toolAttempts: s.number().min(1).max(10).step(1).default(3),
      retryDelayMs: s.number().min(1).max(60000).step(1).default(1000),
      maxToolCalls: s.number().min(1).max(100000).step(1).default(10000),
      maxToolResultBytes: s.number().min(1024).max(16777216).step(1).default(1048576),
      replaySafeTools: s.array(s.string()).default([]),
      retryableToolCodes: s.array(s.string()).default(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']),
    }).default(runtimePolicySchema.parse({})),
    tracePreviewChars: s.number().min(64).max(16000).step(1).default(4000),
    workspaceId: s.string().default('shared'), workspaceName: s.string().default('Shared workspace'),
    ownerTeamId: s.string().default('shared-team'), ownerTeamName: s.string().default('Shared team'),
  })
  private resourceStore!: SharedResources
  private governance: Governance | undefined
  private readonly restrictedAgents = new WeakSet<object>()
  private get resources(): SharedResources { return this.resourceStore.forWorkspace(this.workspace.id) }
  private get workspace(): import('./types.ts').RegistryWorkspace {
    const principal = currentPrincipal()
    if (this.governance === undefined || principal === undefined) return this.registry.workspace
    return this.workspaceRecord(principal.workspaceId)
  }
  private workspaceRecord(id: string): import('./types.ts').RegistryWorkspace {
    const governance = this.governance
    if (governance === undefined) throw new Error('Governance is not configured')
    const row = governance.workspace(id)
    return { id: row.id, name: row.name, ownerTeamId: row.id, ownerTeamName: row.name, accessMode: 'governed' }
  }
  private require(action: WorkspaceAction, workspaceId = this.workspace.id): void {
    if (this.governance === undefined) return
    const principal = currentPrincipal()
    if (principal === undefined) throw new GovernanceError(401, 'Authentication required')
    if (principal.workspaceId !== workspaceId) throw new GovernanceError(404, 'Resource not found')
    this.governance.authorize(principal.userId, workspaceId, action)
  }
  private userOnly(): boolean {
    const principal = currentPrincipal()
    return this.governance !== undefined && principal !== undefined
      && this.governance.authorize(principal.userId, principal.workspaceId, 'read') === 'user'
  }
  private async readableRun(workspace: string, id: string, runId: string): Promise<PlatformRun> {
    const run = await this.runs.get(workspace, id, runId)
    if (this.userOnly() && run.createdBy !== platformActor()) throw new GovernanceError(404, 'Resource not found')
    return run
  }
  private projectRun(run: PlatformRun): PlatformRun {
    if (!this.userOnly()) return run
    const { runtime: _runtime, ...result } = run
    return { ...result, events: [], error: run.error === null ? null : { code: run.error.code, message: 'Run failed' } }
  }
  private authorizeExecution(run: PlatformRun): void {
    if (this.governance === undefined) return
    this.governance.authorize(run.createdBy, run.platformWorkspaceId, 'run')
    const agent = this.registry.get(run.platformWorkspaceId, run.agentId)
    if (agent.lifecycle !== 'active') throw new GovernanceError(403, 'Agent is archived')
    this.assertVersionResources(this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId))
  }
  private registry!: AgentRegistry
  private versions!: AgentVersions
  private deployments!: AgentDeployments
  private runs!: PlatformRuns
  private traces!: PlatformTraces
  private observability!: PlatformObservability
  private readonly stores: { close(): Promise<void> }[] = []
  private importErrors: string[] = []

  protected async [Service.init](): Promise<void> {
    if (this.config.governanceFile !== undefined) {
      this.governance = await Governance.open(this.ctx.storageDomain, JSON.parse(await readFile(this.config.governanceFile, 'utf8')))
      this.stores.push(this.governance)
    }
    this.registry = await AgentRegistry.open(this.ctx.storageDomain, {
      id: this.config.workspaceId ?? 'shared', name: this.config.workspaceName ?? 'Shared workspace',
      ownerTeamId: this.config.ownerTeamId ?? 'shared-team', ownerTeamName: this.config.ownerTeamName ?? 'Shared team',
      accessMode: 'shared-host',
    }, this.governance === undefined ? undefined : id => this.workspaceRecord(id))
    this.ctx.effect(() => async () => {
      const failures: unknown[] = []
      if (this.runs !== undefined) {
        try { await this.runs.stop() } catch (error) { failures.push(error) }
      }
      for (const store of [...this.stores.toReversed(), this.registry]) {
        try { await store.close() } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'AgentBuilder storage shutdown failed')
    }, 'agent-builder.storage-close')
    this.resourceStore = await SharedResources.open(this.ctx.storageDomain, this.registry.workspace.id)
    this.stores.push(this.resourceStore)
    this.versions = await AgentVersions.open(this.ctx.storageDomain, this.registry)
    this.stores.push(this.versions)
    this.deployments = await AgentDeployments.open(this.ctx.storageDomain, this.registry, this.versions)
    this.stores.push(this.deployments)
    this.runs = await PlatformRuns.open(this.ctx, this.registry, this.versions, this.deployments, this.config.root)
    this.stores.push(this.runs)
    this.traces = await PlatformTraces.open(this.ctx, this.runs, this.config.tracePreviewChars ?? 4000)
    this.stores.push(this.traces)
    const prices = validatePrices(this.config.observabilityPricesFile === undefined ? []
      : JSON.parse(await readFile(this.config.observabilityPricesFile, 'utf8')))
    this.observability = await PlatformObservability.open(this.ctx, this.runs, this.traces, this.versions, prices, this.config.observabilityRefreshMs ?? 1000)
    this.stores.push(this.observability)
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
    const governance = this.governance
    if (governance !== undefined) {
      this.registry.validateOwnership((agent) => {
        if (agent.resources !== undefined) this.resourceStore.forWorkspace(agent.platformWorkspaceId).validateReferences(agent.resources)
      })
      this.versions.validateOwnership((version) => {
        const refs = version.snapshot.resources
        if (refs !== undefined) this.resourceStore.forWorkspace(version.platformWorkspaceId).validateReferences({
          model: { resourceId: refs.model.resourceId, versionId: refs.model.id },
          tools: refs.tools.map(row => ({ resourceId: row.resourceId, versionId: row.id })),
          skills: refs.skills.map(row => ({ resourceId: row.resourceId, versionId: row.id })),
        })
      })
      this.deployments.validateOwnership()
      this.resourceStore.validateOwnership((id) => { governance.workspace(id) })
      this.runs.validateOwnership()
    }
    if (this.governance !== undefined) mountPlatformHttp(this.ctx, this, this.governance)
    this.runs.startWorkers(runtimePolicySchema.parse(this.config.runtime ?? {}),
      version => this.prepareVersion(version), (run) => { this.authorizeExecution(run) })
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
    ctx.inject(['tools'], (scope) => {
      scope.effect(() => scope.tools.guard((exec) => {
        const run = exec.agent === undefined ? undefined : this.runs.forSession(exec.agent.session.id)
        if (run === undefined) return undefined
        try {
          this.authorizeExecution(run)
          const version = this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId)
          this.assertVersionResources(version)
          if (this.governance !== undefined && !version.snapshot.toolIds.includes(exec.name)) return 'Tool is not bound to this Agent version'
          return undefined
        }
        catch (error) { return error instanceof Error ? error.message : String(error) }
      }), 'agent-builder.resource-availability')
    })
    ctx.on('agent/request', async ({ agent }, next) => {
      const inherited = await next()
      const run = this.runs.forSession(agent.session.id)
      if (run === undefined) return inherited
      this.authorizeExecution(run)
      const version = this.versions.get(run.platformWorkspaceId, run.agentId, run.agentVersionId)
      this.assertVersionResources(version)
      if (this.governance !== undefined && !this.restrictedAgents.has(agent)) {
        agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: version.snapshot.toolIds }), 'platform.bound-tools')
        this.restrictedAgents.add(agent)
      }
      return versionCallConfig(version)
    })
  }

  /**
   * Read templates and saved Agents together with currently configured models.
   * @returns current authoring choices without creating a Session.
   */
  @Remote('catalog')
  async catalog(): Promise<AgentBuilderCatalog> {
    if (this.governance !== undefined) throw new GovernanceError(403, 'Use the Workspace catalog')
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
    if (this.governance !== undefined) { this.require('edit'); if (!['customer-service', 'data', 'operations'].includes(id)) throw new GovernanceError(404, 'Resource not found') }
    const preset = await this.ctx.agentPresets.resolve(id)
    const text = await readFile(preset.path, 'utf8')
    if (resolve(preset.path) === resolve(this.config.root, id, 'agent.cordis.yml')) {
      const { requestToken, ...value } = parseDefinition(text)
      if (definitionId(requestToken) !== id) throw new Error('Saved Agent identity does not match its submission')
      return { ...value, id: definitionId(requestToken), builtin: false }
    }
    if (!['customer-service', 'data', 'operations'].includes(id)) throw new RemoteError('gateway/bad-request',
      'Not a business Agent template', {})
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
    if (this.governance !== undefined) throw new GovernanceError(403, 'Use Workspace authoring')
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
    this.require('edit')
    const models = await this.ctx.sessionController.modelCatalog()
    const agents = await Promise.all(['customer-service', 'data', 'operations'].map(id => this.get(id)))
    if (this.governance === undefined) await this.resources.seed(models, this.workspace.ownerTeamId)
    return { models, agents, tools: TOOL_CHOICES, resources: this.resources.list(), workspace: this.workspace,
      importErrors: this.importErrors }
  }

  /** List summaries without materializing Prompt bodies.
   * @param query - workspace, filters and pagination.
   * @returns bounded resource page.
   */
  @Remote('registryList')
  async registryList(query: RegistryQuery): Promise<RegistryPage> {
    this.require('read', query.workspaceId)
    return this.registryCall(() => this.registry.list(query, this.userOnly() ? agent =>
      agent.lifecycle === 'active' && this.deployments.get(query.workspaceId, agent.id) !== null : undefined))
  }

  /** Read current metadata and draft.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @returns current resource including archived state.
   */
  @Remote('registryGet')
  async registryGet(workspaceId: string, id: string): Promise<RegistryAgent> {
    this.require('edit', workspaceId)
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
    this.require('edit', workspaceId)
    return this.registryCall(async () => {
      this.registry.list({ workspaceId, limit: 1 })
      const value = this.resolveDraft(registryInputSchema.parse(input))
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
    this.require('edit', workspaceId)
    return this.registryCall(async () => {
      const current = this.registry.get(workspaceId, id)
      const value = this.resolveDraft(registryInputSchema.parse(input), current.resources)
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
    this.require('edit', workspaceId)
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
    this.require('edit', workspaceId)
    return this.registryCall(() => this.versions.create(workspaceId, id, revision, token, note, async (draft) => {
      inputSchema.parse({ name: draft.name, prompt: draft.prompt, model: draft.model, toolIds: draft.toolIds })
      await this.validateModel(draft)
      return this.ctx.llm.resolveCallConfig({ provider: draft.model.provider, model: draft.model.model })
    }, draft => draft.resources === undefined ? undefined : this.resources.resolve(draft.resources, true)))
  }

  /** List historical version summaries.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param cursor - zero-based page offset.
   * @returns bounded version metadata.
   */
  @Remote('versionList')
  async versionList(workspaceId: string, id: string, cursor: number): Promise<AgentHistoryPage<AgentVersionSummary>> {
    this.require('edit', workspaceId)
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
    this.require('edit', workspaceId)
    return this.registryCall(() => this.versions.get(workspaceId, id, versionId))
  }

  /** Read the current default deployment.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @returns activation or null before first deployment.
   */
  @Remote('deploymentGet')
  async deploymentGet(workspaceId: string, id: string): Promise<AgentDeployment | null> {
    this.require('read', workspaceId)
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
    this.require('edit', workspaceId)
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
    this.require('edit', workspaceId)
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
    this.require('run', workspaceId)
    return this.registryCall(async () => this.projectRun(
      await this.runs.start(workspaceId, id, prompt, token, version => this.prepareVersion(version))))
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
    this.require('read', workspaceId)
    return this.registryCall(async () => {
      const page = await this.runs.list(workspaceId, id, cursor, versionId, status, this.userOnly() ? platformActor() : undefined)
      return { ...page, items: page.items.map(run => this.projectRun(run)) }
    })
  }

  /** Read a Run with the version selected at admission.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @returns attribution and Harness-derived status.
   */
  @Remote('runGet')
  async runGet(workspaceId: string, id: string, runId: string): Promise<PlatformRun> {
    this.require('read', workspaceId)
    return this.registryCall(async () => this.projectRun(await this.readableRun(workspaceId, id, runId)))
  }

  /** Read execution accounting for an authorized task.
   * @param workspaceId - organization scope.
   * @param id - Agent identity.
   * @param runId - task identity.
   * @returns persisted Trace summary and availability.
   */
  @Remote('runTraceGet')
  async runTraceGet(workspaceId: string, id: string, runId: string): Promise<RunTrace> {
    this.require('edit', workspaceId)
    return this.registryCall(async () => this.traces.get(await this.runs.get(workspaceId, id, runId)))
  }

  private analysisScope(workspace: string, input: ObservationQuery): ObservationQuery {
    const query = observationQuerySchema.parse(input)
    this.require(query.agentId === undefined ? 'admin' : 'edit', workspace)
    if (query.agentId !== undefined) {
      this.registry.get(workspace, query.agentId)
      if (query.versionId !== undefined) this.versions.get(workspace, query.agentId, query.versionId)
      if (query.compareVersionId !== undefined) this.versions.get(workspace, query.agentId, query.compareVersionId)
    }
    return query
  }

  /** Analyze an Agent or administrator-authorized workspace using published facts.
   * @param workspaceId - organization scope.
   * @param query - explicit cohort and optional version/resource filters.
   * @returns metrics, coverage, trends and comparison.
   */
  @Remote('observabilityQuery')
  async observabilityQuery(workspaceId: string, query: ObservationQuery): Promise<ObservationReport> {
    return this.registryCall(() => this.observability.query(workspaceId, this.analysisScope(workspaceId, query)))
  }

  /** List the same analysis cohort for Trace drill-down.
   * @param workspaceId - organization scope.
   * @param query - exact report filters.
   * @param cursor - opaque filter-bound cursor.
   * @param limit - bounded page size.
   * @returns links to authorized Run details.
   */
  @Remote('observabilityRuns')
  async observabilityRuns(workspaceId: string, query: ObservationQuery, cursor?: string, limit?: number): Promise<ObservationRunPage> {
    return this.registryCall(() => this.observability.page(workspaceId, this.analysisScope(workspaceId, query), cursor, limit))
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
    this.require('edit', workspaceId)
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
    this.require('read', workspaceId)
    return this.registryCall(async () => {
      await this.readableRun(workspaceId, id, runId)
      return this.projectRun(await this.runs.cancel(workspaceId, id, runId))
    })
  }

  /** Record externally verified evidence for a blocked tool call.
   * @param workspaceId - organization workspace.
   * @param id - owning Agent.
   * @param runId - blocked Run.
   * @param callId - original tool invocation identity.
   * @param decision - externally established outcome.
   * @param evidence - verification evidence retained in the audit record.
   * @param token - idempotent request identity.
   * @returns Run queued for recovery after the decision is durable.
   */
  @Remote('runResolve')
  async runResolve(workspaceId: string, id: string, runId: string, callId: string, decision: 'completed' | 'not-executed', evidence: string, token: string): Promise<PlatformRun> {
    this.require('admin', workspaceId)
    return this.registryCall(() => this.runs.resolve(workspaceId, id, runId, callId, decision, evidence, token))
  }

  /** Resolve a managed Session for the execution-page cancellation entry.
   * @param sessionId - existing Session identity.
   * @returns task after checking its configured organization scope.
   */
  @Remote('runForSession')
  async runForSession(sessionId: string): Promise<PlatformRun> {
    this.require('edit')
    return this.registryCall(() => {
      const run = this.runs.forSession(sessionId)
      if (run === undefined) throw new RegistryError('not-found', 'Run not found')
      return this.runs.get(this.workspace.id, run.agentId, run.id)
    })
  }

  private async prepareVersion(version: AgentVersion): Promise<void> {
    this.assertVersionResources(version)
    const input = { name: version.id, prompt: version.snapshot.prompt, model: version.snapshot.model, toolIds: version.snapshot.toolIds }
    inputSchema.parse(input)
    await this.validateModel(input)
    await this.ctx.llm.resolveCallConfig(versionCallConfig(version))
    await prepareVersionPreset(this.config.root, version)
    await this.ctx.agentPresets.standingKeyFor(version.id)
  }

  /** List all managed resources and their published versions.
   * @returns public configuration without credentials.
   */
  @Remote('resourceList')
  async resourceList(): Promise<SharedResource[]> {
    this.require('edit')
    return this.registryCall(async () => {
      if (this.governance === undefined) {
        await this.resources.seed(await this.ctx.sessionController.modelCatalog(), this.workspace.ownerTeamId)
      }
      return this.resources.list()
    })
  }

  /** Register an unpublished resource draft.
   * @param input - resource metadata and configuration.
   * @param token - retry UUID.
   * @returns saved draft.
   */
  @Remote('resourceCreate')
  async resourceCreate(input: ResourceInput, token: string): Promise<SharedResource> {
    this.require('admin')
    return this.registryCall(async () => { await this.validateResource(input); return this.resources.create(input, token) })
  }

  /** Edit the next resource version, retaining all published content.
   * @param id - resource identity.
   * @param revision - loaded revision.
   * @param input - replacement draft.
   * @returns updated resource.
   */
  @Remote('resourceUpdate')
  async resourceUpdate(id: string, revision: number, input: ResourceInput): Promise<SharedResource> {
    this.require('admin')
    return this.registryCall(async () => { await this.validateResource(input); return this.resources.update(id, revision, input) })
  }

  /** Publish a resource draft without changing any Agent binding.
   * @param id - resource identity.
   * @param revision - loaded revision.
   * @param token - retry UUID.
   * @returns immutable resource version.
   */
  @Remote('resourcePublish')
  async resourcePublish(id: string, revision: number, token: string): Promise<ResourceVersion> {
    this.require('admin')
    return this.registryCall(() => this.resources.publish(id, revision, token))
  }

  /** Change resource availability without deleting historical content.
   * @param id - resource identity.
   * @param revision - loaded revision.
   * @param status - new availability.
   * @returns saved resource.
   */
  @Remote('resourceStatus')
  async resourceStatus(id: string, revision: number, status: ResourceStatus): Promise<SharedResource> {
    this.require('admin')
    return this.registryCall(() => this.resources.setStatus(id, revision, status))
  }

  /** Derive consumers from Agent drafts and immutable versions.
   * @param id - resource identity.
   * @returns direct uses, including deployed and historical Agent versions.
   */
  @Remote('resourceUsage')
  async resourceUsage(id: string): Promise<ResourceUsage[]> {
    this.require('edit')
    return this.registryCall(() => {
      this.resources.get(id)
      const workspace = this.workspace.id
      const result: ResourceUsage[] = []
      let cursor: string | undefined
      do {
        const page = this.registry.list({ workspaceId: workspace, lifecycle: 'all', limit: 100,
          ...(cursor === undefined ? {} : { cursor }) })
        for (const summary of page.items) {
          const agent = this.registry.get(workspace, summary.id)
          const refs = agent.resources
          if (refs !== undefined && [refs.model, ...refs.tools, ...refs.skills].some(ref => ref.resourceId === id)) {
            result.push({ agentId: agent.id, agentName: agent.name, versionId: null, versionNumber: null, deployed: false })
          }
          let versionCursor: number | null = 0
          while (versionCursor !== null) {
            const versions = this.versions.list(workspace, agent.id, versionCursor)
            for (const item of versions.items) {
              const manifest = this.versions.get(workspace, agent.id, item.id).snapshot.resources
              if (manifest !== undefined && [manifest.model, ...manifest.tools, ...manifest.skills].some(ref => ref.resourceId === id)) {
                result.push({ agentId: agent.id, agentName: agent.name, versionId: item.id, versionNumber: item.versionNumber,
                  deployed: this.deployments.get(workspace, agent.id)?.versionId === item.id })
              }
            }
            versionCursor = versions.nextCursor
          }
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      return result
    })
  }

  /** Import installed resource adapters for an authorized workspace administrator. */
  async seedWorkspaceResources(): Promise<void> {
    this.require('admin')
    if (this.governance !== undefined && this.governance.workspace(this.workspace.id).status !== 'active') throw new GovernanceError(403, 'Workspace is archived')
    await this.resources.seed(await this.ctx.sessionController.modelCatalog(), this.workspace.ownerTeamId)
  }

  private async validateResource(input: ResourceInput): Promise<void> {
    const value = resourceInputSchema.parse(input)
    if (value.spec.kind === 'model') await this.validateModel({ name: value.name, prompt: '-', toolIds: [], model: value.spec })
  }

  private resolveDraft(input: RegistryAgentInput, previous?: AgentResources): RegistryAgentInput {
    const refs = input.resources ?? this.resources.legacyRefs(input.model, input.toolIds)
    if (refs === undefined) {
      if (this.governance !== undefined) throw new GovernanceError(403, 'Bind published Workspace resources')
      return input
    }
    const manifest = this.resources.resolve(refs, true)
    const prior = previous === undefined ? [] : [previous.model, ...previous.tools, ...previous.skills]
    for (const ref of [refs.model, ...refs.tools, ...refs.skills]) {
      if (!prior.some(old => old.resourceId === ref.resourceId && old.versionId === ref.versionId)
        && this.resources.get(ref.resourceId).status !== 'active') throw new RegistryError('conflict',
        'New references require an active resource')
    }
    if (manifest.model.spec.kind !== 'model') throw new RegistryError('conflict', 'Model resource required')
    return { ...input, resources: refs, model: { provider: manifest.model.spec.provider, model: manifest.model.spec.model },
      toolIds: manifest.tools.map((tool) => { if (tool.spec.kind !== 'tool') throw new RegistryError('conflict',
        'Tool resource required'); return tool.spec.operation }) }
  }

  private assertVersionResources(version: AgentVersion): void {
    const resources = this.resourceStore.forWorkspace(version.platformWorkspaceId)
    let manifest: ResourceManifest | undefined = version.snapshot.resources
    if (manifest === undefined) {
      const refs = resources.legacyRefs(version.snapshot.model, version.snapshot.toolIds)
      if (refs !== undefined) manifest = resources.resolve(refs, true)
    }
    if (manifest !== undefined) resources.assertAvailable(manifest)
    else if (this.governance !== undefined) throw new GovernanceError(403, 'Version has no Workspace resource bindings')
  }

  private async registryCall<T>(action: () => T | Promise<T>): Promise<T> {
    try { this.require('read'); return await action() }
    catch (error) {
      if (error instanceof RegistryError) throw new RemoteError(`agent-registry/${error.code}`, error.message, {})
      if (error instanceof ZodError) throw new RemoteError('agent-registry/validation',
        error.issues.map(issue => issue.message).join('; '), {})
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
