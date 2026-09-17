/** Durable Run trace projection; observation failures never decide task outcomes. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { PlatformRuns } from './platform-runs.ts'
import type { PlatformRun } from './types.ts'
import type { RunTrace, RunTracePage, TraceModelStart } from './trace-types.ts'
import { traceSpec } from './trace-schema.ts'
import { projectTrace } from './trace-projection.ts'
import { RegistryError } from './registry.ts'

const PAGE_SIZE = 100
const relevant = new Set(['turn/start', 'turn/end', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'llm/retry'])
const cursorSchema = z.object({ runId: z.string(), version: z.literal(1), revision: z.string(), offset: z.number().int().nonnegative() })

/** Single-Host trace storage and read API, with coalesced source-log reconciliation. */
export class PlatformTraces {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly dirty = new Map<string, PlatformRun>()
  private readonly faults = new Set<string>()
  private readonly starts = new Map<string, TraceModelStart[]>()
  private readonly routes = new Map<string, { provider: string; model: string }>()
  private readonly unlisten: (() => void)[] = []
  private closing = false
  private constructor(
    private readonly ctx: Context, private readonly runs: PlatformRuns,
    private readonly domain: Domain<typeof traceSpec>, private readonly previewLimit: number,
  ) {}

  /** Open and observe task facts without changing Harness execution.
   * @param ctx - existing Harness and storage services.
   * @param runs - authoritative task owner.
   * @param previewLimit - configured maximum preview characters.
   * @returns disposable Trace reader and recorder.
   */
  static async open(ctx: Context, runs: PlatformRuns, previewLimit: number): Promise<PlatformTraces> {
    const store = new PlatformTraces(ctx, runs, await ctx.storageDomain.open(traceSpec), previewLimit)
    for (const [, start] of store.domain.table('starts').entries()) {
      const list = store.starts.get(start.runId) ?? []
      list.push(start); store.starts.set(start.runId, list)
    }
    store.unlisten.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type !== 'start') return
      const run = runs.forSession(agent.session.id)
      if (run === undefined) return
      const route = store.routes.get(run.id)
      const afterSeq = agent.session.seq - 1
      const start: TraceModelStart = { id: `${run.id}:model:${afterSeq}`, runId: run.id, afterSeq,
        occurredAt: new Date().toISOString(), turn: frame.turn, step: frame.step,
        provider: route?.provider ?? null, model: route?.model ?? null }
      const list = store.starts.get(run.id) ?? []
      if (list.some(item => item.id === start.id)) return
      list.push(start); store.starts.set(run.id, list)
      store.schedule(run)
    }))
    store.unlisten.push(ctx.on('session/event', (session, event) => {
      const run = runs.forSession(session.id)
      if (run !== undefined && event.type === 'request/context') store.routes.set(run.id, event.data)
      if (!relevant.has(event.type)) return
      if (run !== undefined) store.schedule(run)
    }))
    store.unlisten.push(ctx.on('domain/changed', (change) => {
      if (change.domain !== 'platform_agent_runs' || change.operation !== 'put') return
      const row = change.value as PlatformRun
      store.schedule(row)
    }))
    // Terminal traces may have lost their last projection write before shutdown.
    for (const [, summary] of store.domain.table('summaries').entries()) {
      if (summary.state === 'pending') {
        const run = runs.forSession(summary.sessionId)
        if (run !== undefined) store.schedule(run)
      }
    }
    return store
  }

  private schedule(run: PlatformRun): void {
    if (this.closing) return
    this.dirty.set(run.id, run)
    if (this.pending.has(run.id)) return
    const job = Promise.resolve().then(async () => {
      while (this.dirty.has(run.id)) {
        this.dirty.delete(run.id)
        try {
          const latest = await this.runs.get(run.platformWorkspaceId, run.agentId, run.id)
          await this.reconcile(latest)
          this.faults.delete(run.id)
        } catch (error) {
          this.faults.add(run.id)
          this.ctx.logger.error('Trace persistence failed for %s: %s', run.id, String(error))
        }
      }
    }).finally(() => {
      this.pending.delete(run.id)
      const again = this.dirty.get(run.id)
      if (again !== undefined) this.schedule(again)
    })
    this.pending.set(run.id, job)
  }

  private async reconcile(run: PlatformRun): Promise<void> {
    let events: readonly SessionEvent[] = []
    const live = this.ctx.agents.get(run.sessionId)
    try { using observed = await this.ctx.sessionQuery.observeSession(run.sessionId); events = observed.events }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    }
    if (live !== undefined) await this.ctx.sessions.flush(live.session)
    const starts = [...(this.starts.get(run.id) ?? [])].sort((a, b) => a.afterSeq - b.afterSeq || a.occurredAt.localeCompare(b.occurredAt))
    for (const start of starts) {
      if (this.domain.table('starts').get(start.id) === undefined) await this.domain.table('starts').put(start.id, start)
    }
    const { trace, items } = projectTrace(run, events, starts, this.previewLimit)
    if (events.length === 0 && run.startedAt !== null) trace.state = 'partial'
    trace.revision = createHash('sha256').update(JSON.stringify({ trace, items })).digest('hex').slice(0, 24)
    const previous = this.domain.table('summaries').get(run.id)
    if (previous?.revision === trace.revision) return
    for (let offset = 0; offset < items.length; offset += PAGE_SIZE) {
      await this.domain.table('pages').put(`${run.id}:${trace.revision}:${offset / PAGE_SIZE}`, items.slice(offset, offset + PAGE_SIZE))
    }
    await this.domain.table('summaries').put(run.id, trace)
    if (previous !== undefined) {
      for (let offset = 0; offset < previous.eventCount; offset += PAGE_SIZE) await this.domain.table('pages').delete(`${run.id}:${previous.revision}:${offset / PAGE_SIZE}`)
    }
  }

  /** Read the durable summary; first access rebuilds legacy or failed projections.
   * @param run - task already authorized by the Runtime API.
   * @returns accounting with explicit availability.
   */
  async get(run: PlatformRun): Promise<RunTrace> {
    if (this.domain.table('summaries').get(run.id) === undefined || this.faults.has(run.id)) this.schedule(run)
    await this.pending.get(run.id)
    const summary = this.domain.table('summaries').get(run.id)
    if (summary === undefined) return { ...projectTrace(run, [], [], this.previewLimit).trace, state: 'unavailable' }
    return { ...summary, ...(this.faults.has(run.id) ? { state: 'partial' as const } : {}) }
  }

  /** Read a bounded page from one published revision, rejecting stale cursors.
   * @param run - task authorized by Runtime.
   * @param cursor - opaque Run/revision-bound position.
   * @param limit - at most 100 events.
   * @returns page with the exact summary used for this read.
   */
  async events(run: PlatformRun, cursor?: string, limit = PAGE_SIZE): Promise<RunTracePage> {
    z.number().int().min(1).max(PAGE_SIZE).parse(limit)
    const trace = await this.get(run)
    let offset = 0
    if (cursor !== undefined) {
      z.string().max(2048).parse(cursor)
      let decoded: z.infer<typeof cursorSchema>
      try { decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))) }
      catch { throw new RegistryError('conflict', 'Invalid Trace cursor') }
      if (decoded.runId !== run.id || decoded.revision !== trace.revision || decoded.offset > trace.eventCount) throw new RegistryError('conflict', 'Trace changed; reload from the first page')
      offset = decoded.offset
    }
    const items = []
    for (let index = offset; index < Math.min(trace.eventCount, offset + limit); index++) {
      const row = this.domain.table('pages').get(`${run.id}:${trace.revision}:${Math.floor(index / PAGE_SIZE)}`)?.[index % PAGE_SIZE]
      if (row === undefined) throw new RegistryError('conflict', 'Trace page unavailable; reload the trace')
      items.push(row)
    }
    const next = offset + items.length
    return { trace, items, nextCursor: next < trace.eventCount ? Buffer.from(JSON.stringify({ runId: run.id, version: 1, revision: trace.revision, offset: next })).toString('base64url') : null }
  }

  /** Drain after Runtime has stopped producing facts, then release the storage. */
  async close(): Promise<void> {
    this.closing = true
    for (const dispose of this.unlisten) dispose()
    await Promise.all(this.pending.values())
    await this.domain.close()
  }
}
