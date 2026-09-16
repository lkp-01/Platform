// One-query worker. Only this fixed program reaches SQLite; model text is never JavaScript.
import { DatabaseSync, constants as c } from 'node:sqlite'

process.once('message', (workerData) => {
  let db
  try {
    db = new DatabaseSync(':memory:', { allowExtension: false })
    if (typeof db.setAuthorizer !== 'function') throw new Error('Data Agent requires Node >=24.10 with SQLite setAuthorizer support')
    db.exec('CREATE TABLE sales(period TEXT, product TEXT, revenue REAL, paid_orders INTEGER, refunded_orders INTEGER, late_delivery_refunds INTEGER)')
    const insert = db.prepare('INSERT INTO sales VALUES (?, ?, ?, ?, ?, ?)')
    for (const row of workerData.rows) insert.run(row.period, row.product, row.revenue, row.paid_orders, row.refunded_orders, row.late_delivery_refunds)
    db.exec('PRAGMA query_only=ON')
    const functions = new Set(['sum', 'avg', 'count', 'min', 'max', 'round', 'abs', 'coalesce', 'nullif', 'ifnull', 'lower', 'upper', 'substr', 'date', 'strftime'])
    db.setAuthorizer((action, arg1, arg2) => {
      if (action === c.SQLITE_SELECT) return c.SQLITE_OK
      if (action === c.SQLITE_READ && arg1 === 'sales') return c.SQLITE_OK
      if (action === c.SQLITE_FUNCTION && functions.has(String(arg2).toLowerCase())) return c.SQLITE_OK
      return c.SQLITE_DENY
    })
    const statement = db.prepare(workerData.sql)
    const result = { columns: statement.columns().map(column => column.name), rows: [], truncated: false }
    for (const row of statement.iterate()) {
      if (result.rows.length >= workerData.maxRows) { result.truncated = true; break }
      result.rows.push(row)
      if (Buffer.byteLength(JSON.stringify(result)) > workerData.maxResultBytes) {
        throw new Error('Query exceeds result byte limit; select fewer columns or rows')
      }
    }
    if (Buffer.byteLength(JSON.stringify(result)) > workerData.maxResultBytes) throw new Error('Query exceeds result byte limit')
    process.send({ ok: true, value: result })
  } catch (error) {
    process.send({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    db?.close()
  }
})
