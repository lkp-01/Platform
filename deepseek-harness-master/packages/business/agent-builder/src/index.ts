/** Form-based Agent authoring over the official Preset registry. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load, JSON_SCHEMA } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { TOOL_CHOICES, definitionId, inputSchema, parseDefinition, tokenSchema } from './definition.ts'
import { publishDefinition } from './authoring.ts'
import type { AgentBuilderCatalog, AgentDefinition, AgentDefinitionInput } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentBuilder: AgentBuilder }
}

/** Host-owned configuration directory. */
interface Config {
  /** Host-owned persistent directory, also included in Preset discovery. */
  root: string
}

/** Creates immutable business definitions without accepting composition code. */
export default class AgentBuilder extends TypertRemoteService {
  static inject = ['agentPresets', 'sessionController', 'llm', 'agentDefaultModel']
  static Config: s<Config> = s.object({ root: s.string().required() })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'agentBuilder')
    ctx.on('api-session/initial-model', async (preset, next) => {
      const inherited = await next()
      if (preset === undefined || !preset.startsWith('agent-')) return inherited
      const resolved = await ctx.agentPresets.resolve(preset)
      if (resolve(resolved.path) !== resolve(config.root, preset, 'agent.cordis.yml')) return inherited
      return (await this.get(preset)).model
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
    return publishDefinition(this.config.root, { ...parsed.data, requestToken: token.data })
  }
}
