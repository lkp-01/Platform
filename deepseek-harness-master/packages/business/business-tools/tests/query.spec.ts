import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSales, querySales } from '../src/data-analysis.ts'

const fixturePath = fileURLToPath(new URL('../fixtures/sales.csv', import.meta.url))
const config = { fixturePath, maxRows: 2, maxResultBytes: 32768, queryTimeoutMs: 3000 }
const rows = parseSales(await readFile(fixturePath, 'utf8'))

describe('bounded read-only query worker', () => {
  it('reports row truncation and supports legitimate CTE aggregate queries', async () => {
    expect(await querySales(rows, 'SELECT product FROM sales', config, new AbortController().signal))
      .toMatchObject({ rows: [{ product: 'A' }, { product: 'B' }], truncated: true })
    expect(await querySales(rows, 'WITH totals AS (SELECT SUM(revenue) AS revenue FROM sales) SELECT revenue FROM totals', config, new AbortController().signal))
      .toMatchObject({ rows: [{ revenue: 422000 }], truncated: false })
  })
  it('bounds the complete result including column names', async () => {
    await expect(querySales(rows, `SELECT product AS "${'x'.repeat(300)}" FROM sales`, { ...config, maxResultBytes: 256 }, new AbortController().signal))
      .rejects.toThrow('byte limit')
  })
  it('terminates a query that exceeds its deadline', async () => {
    await expect(querySales(rows, 'SELECT COUNT(*) FROM sales a, sales b, sales c, sales d, sales e, sales f, sales g, sales h, sales i, sales j', { ...config, queryTimeoutMs: 30 }, new AbortController().signal))
      .rejects.toThrow('deadline')
  })
  it('enforces the deadline after synchronous SQLite work has started', async () => {
    const started = Date.now()
    const sql = 'SELECT COUNT(*) FROM sales a,sales b,sales c,sales d,sales e,sales f,sales g,sales h,sales i,sales j,sales k'
    await expect(querySales(rows, sql, { ...config, queryTimeoutMs: 500 }, new AbortController().signal)).rejects.toThrow('deadline')
    expect(Date.now() - started).toBeLessThan(1500)
  })
  it('cancels before creation and during a worker query without affecting another query', async () => {
    const early = new AbortController()
    early.abort(new Error('early cancel'))
    await expect(querySales(rows, 'SELECT 1', config, early.signal)).rejects.toThrow('early cancel')
    const running = new AbortController()
    const pending = querySales(rows, 'SELECT COUNT(*) FROM sales a, sales b, sales c, sales d, sales e, sales f, sales g, sales h, sales i, sales j', config, running.signal)
    running.abort(new Error('cancel one query'))
    await expect(pending).rejects.toThrow('cancel one query')
    expect(await querySales(rows, 'SELECT COUNT(*) AS n FROM sales', config, new AbortController().signal)).toMatchObject({ rows: [{ n: 6 }] })
  })
  it.each([
    'wrong,header\n1,2',
    'period,product,revenue,paid_orders,refunded_orders,late_delivery_refunds\n2026-08,A,10,1,3,0',
    'period,product,revenue,paid_orders,refunded_orders,late_delivery_refunds\n2026-13,A,10,1,0,0',
  ])('rejects invalid fixture data', (csv) => { expect(() => parseSales(csv)).toThrow() })
})
