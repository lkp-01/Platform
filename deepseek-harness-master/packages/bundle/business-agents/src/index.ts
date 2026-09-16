/** Package-relative configuration for the optional business Agent composition. */
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { businessAgentPaths: BusinessAgentPaths }
}

/** Resolves shipped preset assets independently of the launch directory. */
export default class BusinessAgentPaths extends Service {
  /** Absolute discovery root for the business preset directories. */
  readonly presetRoot: string = fileURLToPath(new URL('../presets/', import.meta.url))
  /** Persistent definitions authored through the business form. */
  readonly managedRoot: string = dshHomePath('business-agents')
  constructor(ctx: Context) { super(ctx, 'businessAgentPaths') }
}
