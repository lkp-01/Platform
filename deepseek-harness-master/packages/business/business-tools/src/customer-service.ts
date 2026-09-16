/** Local knowledge, mock order lookup and simulated customer tickets. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRecord, isolateTools, jsonOutput, recordOutput, text } from './shared.ts'

export const name = 'business-customer-service'
export const inject = ['tools', 'sessionProjections']
/** Local customer fixture and result limits. */
export interface Config { enabledTools?: ('knowledge_search' | 'order_query' | 'ticket_create')[]; fixturePath: string; maxResults: number; maxRecords: number }
export const Config: s<Config> = s.object({
  enabledTools: s.array(s.union(['knowledge_search','order_query','ticket_create'] as const)).default(['knowledge_search','order_query','ticket_create']),
  fixturePath: s.string().default(fileURLToPath(new URL('../fixtures/customer.json', import.meta.url))),
  maxResults: s.number().min(1).max(10).default(5),
  maxRecords: s.number().min(1).max(1000).default(100),
})
const fixtureSchema = z.object({
  knowledge: z.array(z.object({ id: z.string(), title: z.string(), content: z.string(), keywords: z.array(z.string()) })),
  orders: z.array(z.object({ id: z.string(), product: z.string(), status: z.string(), expectedShipDate: z.string() })),
})

/** Register only customer tools in the preset scope; malformed fixtures fail activation. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const data = fixtureSchema.parse(JSON.parse(await readFile(config.fixturePath, 'utf8')))
  isolateTools(ctx)
  if (config.enabledTools === undefined || config.enabledTools.includes('knowledge_search')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'knowledge_search', description: 'Search local product policies and FAQ. Cite returned source ids; no hits means the policy is unknown.',
    parameters: { query: { type: 'string', required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute({ query }, exec) {
      exec.signal.throwIfAborted()
      const wanted = text(query, 'query', 500).toLowerCase()
      const hits = data.knowledge.map(doc => ({ doc, score: doc.keywords.filter(word => wanted.includes(word.toLowerCase())).length }))
        .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
      return Promise.resolve({ mock: true, results: hits.slice(0, config.maxResults).map(({ doc }) => ({
        docId: doc.id, title: doc.title, snippet: doc.content, source: `knowledge:${doc.id}`,
      })) })
    },
  })), 'customer.knowledge')
  if (config.enabledTools === undefined || config.enabledTools.includes('order_query')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'order_query', description: 'Look up a demo customer order by its exact orderId. Never infer a missing order.',
    parameters: { orderId: { type: 'string', required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute({ orderId }, exec) {
      exec.signal.throwIfAborted()
      return Promise.resolve({ mock: true, order: data.orders.find(order => order.id === text(orderId, 'orderId', 80)) ?? null })
    },
  })), 'customer.order')
  if (config.enabledTools === undefined || config.enabledTools.includes('ticket_create')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ticket_create', description: 'Create a simulated support ticket for a known order. Use escalated=true for escalation; repeat the same requestKey only for the same request.',
    parameters: {
      orderId: { type: 'string', required: true }, summary: { type: 'string', required: true },
      escalated: { type: 'boolean', required: true }, requestKey: { type: 'string', required: true },
    }, output: recordOutput,
    execute(args, exec) {
      if (!data.orders.some(order => order.id === args.orderId)) throw new Error('Unknown orderId')
      return Promise.resolve(createRecord(ctx, exec, 'ticket', args.requestKey, {
        orderId: args.orderId, summary: text(args.summary, 'summary'),
        status: args.escalated ? 'escalated' : 'open',
      }, config.maxRecords))
    },
  })), 'customer.ticket')
}
