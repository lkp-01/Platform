/** Session-local simulated records, derived exclusively from committed tool results. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'

export const name = 'business-tools'
export const inject = ['sessionProjections']

const recordSchema = z.object({
  id: z.string(), kind: z.enum(['ticket', 'task', 'message']), requestKey: z.string(),
  sessionId: z.string(), mock: z.literal(true), payload: z.json(),
})
/** One simulated write committed in its owning Session's tool-result history. */
export type BusinessRecord = z.infer<typeof recordSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    businessRecords: BusinessRecord[]
  }
}

/** Install the record fold once on the host; tool plugins never own shared mutable records. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'businessRecords',
    stateSchema: z.array(recordSchema),
    stateVersion: 1,
    init: () => [],
    apply: (state, event) => {
      if (event.type !== 'tool/result') return state
      const parsed = recordSchema.safeParse(event.data.meta)
      if (!parsed.success || state.some(item => item.id === parsed.data.id)) return state
      return [...state, parsed.data]
    },
  }), 'business-tools.records')
}
