/** Bounded CSV access, read-only SQLite queries and numeric analysis. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isolateTools, jsonOutput, text } from './shared.ts'

export const name = 'business-data-analysis'
export const inject = ['tools']
/** CSV fixture and bounded query execution settings. */
export interface Config { enabledTools?: ('data_catalog' | 'sql_query' | 'dataset_read' | 'data_analyze')[]; fixturePath: string; maxRows: number; maxResultBytes: number; queryTimeoutMs: number }
export const Config: s<Config> = s.object({
  enabledTools: s.array(s.union(['data_catalog','sql_query','dataset_read','data_analyze'] as const)).default(['data_catalog','sql_query','dataset_read','data_analyze']),
  fixturePath: s.string().default(fileURLToPath(new URL('../fixtures/sales.csv', import.meta.url))),
  maxRows: s.number().min(1).max(1000).default(100),
  maxResultBytes: s.number().min(256).max(1000000).default(32768),
  queryTimeoutMs: s.number().min(10).max(30000).default(3000),
})
const columns = ['period', 'product', 'revenue', 'paid_orders', 'refunded_orders', 'late_delivery_refunds'] as const
type Sale = {
  period: string
  product: string
  revenue: number
  paid_orders: number
  refunded_orders: number
  late_delivery_refunds: number
}

/**
 * Read the fixed-column demo CSV and reject malformed or unbounded input.
 * @param csv - fixture file text.
 * @returns validated sales rows.
 */
export function parseSales(csv: string): Sale[] {
  if (Buffer.byteLength(csv) > 1000000) throw new Error('Sales fixture exceeds 1 MB')
  const lines = csv.trim().split(/\r?\n/)
  if (lines.shift() !== columns.join(',')) throw new Error('Unexpected sales CSV columns')
  if (lines.length === 0 || lines.length > 10000) throw new Error('Sales fixture must contain 1–10000 rows')
  return lines.map((line) => {
    const parts = line.split(',')
    const [period, product] = parts
    const numbers = parts.slice(2).map(Number)
    if (parts.length !== 6 || !period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !product
      || numbers.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid sales CSV row')
    const [revenue, paid_orders, refunded_orders, late_delivery_refunds] = numbers as [number, number, number, number]
    if (![paid_orders, refunded_orders, late_delivery_refunds].every(Number.isInteger)
      || refunded_orders > paid_orders || late_delivery_refunds > refunded_orders) throw new Error('Invalid refund counts')
    return { period, product, revenue, paid_orders, refunded_orders, late_delivery_refunds }
  })
}

/**
 * Run an isolated query and await worker teardown on every outcome.
 * @param rows - validated fixture rows.
 * @param sql - one read-only SQL statement.
 * @param config - query resource limits.
 * @param signal - owning execution cancellation.
 * @returns bounded JSON query results.
 */
export async function querySales(rows: Sale[], sql: string, config: Config, signal: AbortSignal): Promise<JsonValue> {
  signal.throwIfAborted()
  const query = text(sql, 'sql', 8000)
  if (query.includes(';')) throw new Error('Supply one query without semicolons')
  // SQLite executes synchronously in native code: an OS process can be killed
  // at the deadline even while a Worker thread would still be inside SQLite.
  const worker = spawn(process.execPath, [
    '--max-old-space-size=32', fileURLToPath(new URL('../runtime/query.mjs', import.meta.url)),
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  const closed = new Promise<void>((resolve) => { worker.once('close', () => { resolve() }) })
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Query cancelled')) }
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => { reject(new Error('Query deadline exceeded')) }, config.queryTimeoutMs)
      worker.once('message', (message: { ok: boolean; value?: unknown; error?: string }) => {
        if (message.ok) {
          const parsed = z.json().safeParse(message.value)
          if (parsed.success) resolve(parsed.data)
          else reject(new Error('Query worker returned invalid JSON'))
        }
        else reject(new Error(message.error ?? 'Query failed'))
      })
      worker.once('error', reject)
      worker.once('exit', (code) => { reject(new Error(`Query worker exited before replying (${code})`)) })
      if (signal.aborted) onAbort()
      else worker.send({ rows, sql: query, maxRows: config.maxRows, maxResultBytes: config.maxResultBytes }, (error) => {
        if (error) reject(error)
      })
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
    await closed
  }
}

/** Register a fixed dataset with no arbitrary filesystem or code execution tools. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const rows = parseSales(await readFile(config.fixturePath, 'utf8'))
  // The optional business composition requires SQLite's authorization API; other presets retain their Node support.
  if (config.enabledTools === undefined || config.enabledTools.includes('sql_query')) {
    await querySales(rows, 'SELECT 1 AS ready', config, new AbortController().signal)
  }
  isolateTools(ctx)
  if (config.enabledTools === undefined || config.enabledTools.includes('data_catalog')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'data_catalog', description: 'Discover the sales dataset, columns, periods and revenue/refund definitions before querying.',
    parameters: {}, output: jsonOutput, isConcurrencySafe: () => true,
    execute(_args, exec) {
      exec.signal.throwIfAborted()
      return Promise.resolve({ datasetId: 'sales', table: 'sales', columns: [...columns], periods: [...new Set(rows.map(row => row.period))],
        currency: 'CNY', revenueDefinition: 'Paid order revenue, before refunds.',
        refundRateDefinition: 'Refunded orders from a period divided by paid orders from that same period.',
        reasonDefinition: 'late_delivery_refunds is a subset of refunded_orders; association does not prove causality.' })
    },
  })), 'data.catalog')
  if (config.enabledTools === undefined || config.enabledTools.includes('sql_query')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sql_query', description: 'Run a single read-only SQLite SELECT on sales. No semicolons, attachments, extensions, administrative statements or writes. Results are bounded.',
    parameters: { sql: { type: 'string', required: true } }, output: jsonOutput,
    async execute({ sql }, exec) { return querySales(rows, sql, config, exec.signal) },
  })), 'data.sql')
  if (config.enabledTools === undefined || config.enabledTools.includes('dataset_read')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'dataset_read', description: 'Read a bounded preview of the sales CSV by datasetId. Arbitrary paths are not accepted.',
    parameters: { datasetId: { type: 'string', required: true }, offset: { type: 'integer', required: true }, limit: { type: 'integer', required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.datasetId !== 'sales') throw new Error('Unknown datasetId')
      if (args.offset < 0 || args.limit < 1 || args.limit > config.maxRows) throw new Error('Invalid preview offset or limit')
      const result = { datasetId: 'sales', rows: rows.slice(args.offset, args.offset + args.limit), totalRows: rows.length,
        truncated: args.offset + args.limit < rows.length }
      if (Buffer.byteLength(JSON.stringify(result)) > config.maxResultBytes) throw new Error('Preview exceeds result byte limit; request fewer rows')
      return Promise.resolve(result)
    },
  })), 'data.read')
  if (config.enabledTools === undefined || config.enabledTools.includes('data_analyze')) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'data_analyze', description: 'Compute from queried numbers: sum(values), change([previous,current]) or rate([numerator,denominator]). Change returns percentage change; rate returns percent.',
    parameters: { operation: { type: 'string', enum: ['sum', 'change', 'rate'], required: true }, values: { type: 'array', items: { type: 'number' }, required: true } },
    output: jsonOutput, isConcurrencySafe: () => true,
    execute({ operation, values }, exec) {
      exec.signal.throwIfAborted()
      if (values.length === 0 || values.length > config.maxRows) throw new Error('Invalid number of values')
      if (operation === 'sum') {
        const sum = values.reduce((a, b) => a + b, 0)
        if (!Number.isFinite(sum)) throw new Error('Numeric overflow')
        return Promise.resolve({ sum })
      }
      if (values.length !== 2) throw new Error('This operation requires exactly two values')
      const [first, second] = values as [number, number]
      if (operation === 'change') {
        const delta = second - first
        const percentChange = first === 0 ? null : delta / Math.abs(first) * 100
        if (!Number.isFinite(delta) || (percentChange !== null && !Number.isFinite(percentChange))) throw new Error('Numeric overflow')
        if (first === 0) return Promise.resolve({ delta, percentChange: null, reason: 'Zero baseline' })
        return Promise.resolve({ delta, percentChange })
      }
      if (second <= 0 || first < 0 || first > second) throw new Error('Rate requires 0 <= numerator <= denominator and denominator > 0')
      return Promise.resolve({ percent: first / second * 100 })
    },
  })), 'data.analyze')
}
