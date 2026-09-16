/** Scoped prompt text and Host-tool isolation for authored Agents. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { storedSchema } from './definition.ts'
import type { StoredDefinition } from './types.ts'

export const name = 'agent-definition'
export const inject = ['systemPrompt', 'tools']
/** Immutable fields persisted by the authoring service. */
export type Config = StoredDefinition
export const Config: s<Config> = s.object({
  name: s.string().required(), prompt: s.string().required(),
  model: s.object({ provider: s.string().required(), model: s.string().required() }).required(),
  toolIds: s.array(s.string()).required(), requestToken: s.string().required(),
})

/**
 * Register literal prompt data and restrict dispatch to the chosen tools.
 * @param ctx - standing Preset scope.
 * @param config - immutable stored definition.
 */
export function apply(ctx: Context, config: Config): void {
  const value = storedSchema.parse(config)
  ctx.effect(() => ctx.systemPrompt.variable('platform_agent_prompt', () => value.prompt), 'agent-builder.prompt')
  const deny = ctx.tools.schemas().map(tool => tool.name)
  ctx.effect(() => ctx.tools.restrict({ deny }), 'agent-builder.inherited-tools')
  ctx.effect(() => ctx.tools.guard(exec => value.toolIds.includes(exec.name) ? undefined : 'Tool is not selected for this Agent'), 'agent-builder.selected-tools')
}
