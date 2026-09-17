/** Durable tool attempts; recovery re-enters the complete Harness tool pipeline. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { reliableRun, type RunRecord } from './run-schema.ts'

const invocation = z.object({ id: z.string(), runId: z.string(), callId: z.string(), name: z.string(), arguments: z.string(),
  state: z.enum(['DISPATCHING', 'RETRY_WAIT', 'DONE']), attempt: z.number().int().nonnegative(),
  nextAttemptAt: z.number().nullable(), result: z.string().nullable(), safe: z.boolean(), nested: z.boolean(),
  recovered: z.boolean().default(false),
  resolution: z.object({ token: z.string(), evidence: z.string(), decision: z.enum(['completed', 'not-executed']), at: z.string() }).nullable().default(null),
  verifiedNotExecuted: z.boolean().default(false),
  history: z.array(z.object({ attempt: z.number().int(), startedAt: z.string(), finishedAt: z.string().nullable(),
    outcome: z.enum(['succeeded', 'failed', 'unknown']), errorCode: z.string().nullable().default(null) })).max(100).default([]),
})
const spec = defineDomain({ name: 'platform_runtime_tools', version: 1, tables: { calls: domainTable(invocation) } })
type Invocation = z.infer<typeof invocation>

/** Distinguishes unknown external outcomes from retryable infrastructure failures. */
export class RecoveryBlocked extends Error {}

/** Journal and barriers owned by the same single-writer runtime as its Run records. */
export class RuntimeTools {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, unknown>()
  private readonly disposers: (() => void)[] = []
  private readonly replaying = new Set<string>()
  private constructor(private readonly ctx: Context, private readonly domain: Domain<typeof spec>) {}

  /** Install durable dispatch barriers and final-result observation.
   * @param ctx - scoped Harness services.
   * @param runForSession - authoritative managed Run lookup.
   * @param authorize - current execution authorization barrier.
   * @returns journal with installed listeners.
   */
  static async open(ctx: Context, runForSession: (id: string) => RunRecord | undefined,
    authorize?: (run: RunRecord) => void): Promise<RuntimeTools> {
    const journal = new RuntimeTools(ctx, await ctx.storageDomain.open(spec))
    journal.disposers.push(ctx.on('tools/execute', async (exec, next) => {
      const agent = exec.agent
      const run = exec.agent === undefined ? undefined : runForSession(exec.agent.session.id)
      if (run?.policy === undefined || agent === undefined) return next()
      authorize?.(run)
      await journal.drain(run.id)
      authorize?.(run)
      exec.signal.throwIfAborted()
      if (run.cancelRequestedAt !== null || Date.now() >= Date.parse(reliableRun(run).runtime.deadlineAt)) {
        throw new Error('Run cancelled or deadline exceeded before tool dispatch')
      }
      await ctx.sessions.flush(agent.session)
      const id = `${run.id}:${exec.callId}`
      const prior = journal.domain.table('calls').get(id)
      if (prior !== undefined && !journal.replaying.has(id)) throw new RecoveryBlocked('Duplicate tool invocation identity')
      if (prior === undefined && journal.calls(run.id).length >= run.policy.maxToolCalls) {
        const error = new Error('Run tool-call budget exhausted')
        journal.failures.set(run.id, error); agent.cancel({ kind: 'disposed' }); throw error
      }
      const row: Invocation = { id, runId: run.id, callId: exec.callId, name: exec.name, arguments: JSON.stringify(exec.arguments),
        state: 'DISPATCHING', attempt: (prior?.attempt ?? 0) + 1, nextAttemptAt: null, result: null,
        safe: run.policy.replaySafeTools.includes(exec.name), nested: exec.parent !== undefined, recovered: prior !== undefined,
        resolution: prior?.resolution ?? null, verifiedNotExecuted: false,
        history: [...prior?.history ?? [], { attempt: (prior?.attempt ?? 0) + 1, startedAt: new Date().toISOString(), finishedAt: null, outcome: 'unknown', errorCode: null }] }
      try { await journal.domain.table('calls').put(id, row) }
      catch (error) { journal.failures.set(run.id, error); agent.cancel({ kind: 'disposed' }); throw error }
      // A durable intent never proves that the external operation completed.
      const result = await next()
      const code = result.error?.info?.code
      if (result.isError && row.safe && !row.nested && !exec.signal.aborted && row.attempt < run.policy.toolAttempts
        && code !== undefined && run.policy.retryableToolCodes.includes(code)) {
        const delay = run.policy.retryDelayMs * 2 ** (row.attempt - 1) * (1 + Math.random())
        await journal.domain.table('calls').put(id, { ...row, state: 'RETRY_WAIT', nextAttemptAt: Date.now() + delay,
          history: row.history.map(item => item.attempt === row.attempt ? { ...item, finishedAt: new Date().toISOString(), outcome: 'failed', errorCode: code } : item) })
        agent.cancel({ kind: 'disposed' })
      }
      return result
    }))
    journal.disposers.push(ctx.on('tools/result', (exec, result) => {
      const agent = exec.agent
      const run = exec.agent === undefined ? undefined : runForSession(exec.agent.session.id)
      if (run?.policy === undefined || agent === undefined) return undefined
      const id = `${run.id}:${exec.callId}`
      if (journal.domain.table('calls').get(id) === undefined) return undefined
      journal.queue(run.id, async () => {
        const serialized = JSON.stringify(result)
        if (Buffer.byteLength(serialized, 'utf8') > reliableRun(run).policy.maxToolResultBytes) throw new RecoveryBlocked('Tool result exceeds the configured durable result budget')
        await journal.domain.table('calls').update(id, row => row.state === 'RETRY_WAIT' ? row
          : exec.signal.aborted ? { ...row, state: 'DISPATCHING', result: null, nextAttemptAt: null }
            : { ...row, state: 'DONE', result: serialized, nextAttemptAt: null,
              history: row.history.map(item => item.attempt === row.attempt
                ? { ...item, finishedAt: new Date().toISOString(), outcome: result.isError ? 'failed' : 'succeeded', errorCode: result.error?.info?.code ?? null } : item),
            })
      }, agent)
      return undefined
    }))
    journal.disposers.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
      const run = runForSession(agent.session.id)
      if (run?.policy !== undefined) {
        authorize?.(run)
        await journal.drain(run.id)
        await ctx.sessions.flush(agent.session)
        if (journal.retryAt(run.id) !== null || run.cancelRequestedAt !== null) return { kind: 'reject' }
        if (Date.now() >= Date.parse(reliableRun(run).runtime.deadlineAt)) throw new Error('Run deadline exceeded')
      }
      return next()
    }))
    return journal
  }

  private queue(id: string, write: () => Promise<void>, agent: Agent): void {
    const tail = (this.tails.get(id) ?? Promise.resolve()).then(write).catch((error: unknown) => {
      this.failures.set(id, error)
      agent.cancel({ kind: 'disposed' })
    })
    this.tails.set(id, tail)
    void tail.then(() => { if (this.tails.get(id) === tail) this.tails.delete(id) })
  }

  /** Await all observed canonical tool-result writes; failures prohibit further dispatch.
   * @param id - Run identity.
   */
  async drain(id: string): Promise<void> {
    await this.tails.get(id)
    if (this.failures.has(id)) throw this.failures.get(id)
  }

  /** Read invocation history for recovery and diagnostics.
   * @param id - Run identity.
   * @returns immutable stored invocations.
   */
  calls(id: string): Invocation[] { return [...this.domain.table('calls').entries()].map(([, row]) => row).filter(row => row.runId === id) }

  /** Earliest time at which all delayed calls can be retried.
   * @param id - Run identity.
   * @returns milliseconds since epoch, or null when no retry is pending.
   */
  retryAt(id: string): number | null {
    const waiting = this.calls(id).filter(row => row.state === 'RETRY_WAIT')
    return waiting.length === 0 ? null : Math.max(...waiting.map(row => row.nextAttemptAt ?? Date.now()))
  }

  /** Refuse automatic recovery of calls whose external outcome cannot be established.
   * @param id - Run identity.
   */
  assertRecoverable(id: string): void {
    const unknown = this.calls(id).find(row => row.state === 'DISPATCHING' && row.attempt > 0 && !row.verifiedNotExecuted && (!row.safe || row.nested))
    if (unknown !== undefined) throw new RecoveryBlocked(`Tool ${unknown.name} (${unknown.callId}) has an unknown external outcome`)
  }

  /** Retry original call identities through Harness, without running a model loop.
   * @param run - claimed task and captured policy.
   * @param agent - resumed, idle Harness agent.
   * @returns logged-context payload for recovered results.
   */
  async recover(run: RunRecord, agent: Agent): Promise<string[]> {
    this.assertRecoverable(run.id)
    for (const row of this.calls(run.id)) {
      if (row.state === 'DONE') continue
      if (row.attempt >= reliableRun(run).policy.toolAttempts) throw new RecoveryBlocked(`Tool ${row.name} exhausted its recovery budget`)
      this.replaying.add(row.id)
      try {
        const result = await agent.runMaintenance(signal => this.ctx.agents.withInitiator(agent, () => this.ctx.tools.execute({
          agent, signal, callId: brandString<ToolCallId>(row.callId), name: row.name,
          arguments: JSON.parse(row.arguments) as unknown,
        })))
        await this.drain(run.id)
        if (this.retryAt(run.id) !== null) break
        // Canonical result observation settles before a continuation is admitted.
        void result
      } finally { this.replaying.delete(row.id) }
    }
    return this.calls(run.id).filter(row => row.recovered && row.state === 'DONE')
      .map(row => JSON.stringify({ callId: row.callId, tool: row.name, result: this.result(row) }))
  }

  /** Preserve a model-requested call that never reached the durable dispatch barrier.
   * @param runId - accepted task identity.
   * @param call - original model call, including its stable identity.
   */
  async prepareUnstarted(runId: string, call: SessionEvent<'tool/call'>['data']): Promise<void> {
    await this.domain.table('calls').put(`${runId}:${call.callId}`, { id: `${runId}:${call.callId}`, runId,
      callId: call.callId, name: call.name, arguments: call.arguments, state: 'DISPATCHING', attempt: 0,
      nextAttemptAt: null, result: null, safe: false, nested: false, recovered: true, resolution: null,
      verifiedNotExecuted: true, history: [] })
  }

  /** Apply a durable operator decision once; evidence stays attached to the invocation.
   * @param run - Run with its persisted recovery decision.
   */
  async applyResolution(run: RunRecord): Promise<void> {
    const resolution = run.runtime?.resolution
    if (resolution == null) return
    const key = `${run.id}:${resolution.callId}`
    await this.domain.table('calls').update(key, (row) => {
      if (row.resolution?.token === resolution.token) return row
      if (row.state !== 'DISPATCHING' || row.nested) throw new RecoveryBlocked('Only an unresolved top-level call can be reconciled')
      return { ...row, resolution, recovered: true,
        ...(resolution.decision === 'not-executed' ? { verifiedNotExecuted: true } : { state: 'DONE' as const,
          result: JSON.stringify({ isError: false, content: [{ type: 'text', text: `Operator verified completion: ${resolution.evidence}` }] }),
        }),
      }
    })
    // A verified outcome replaces the unresolved result that caused a local barrier.
    if (this.failures.get(run.id) instanceof RecoveryBlocked) this.failures.delete(run.id)
  }

  /** Decode a canonical result recorded by this journal.
   * @param row - validated invocation record.
   * @returns result whose model-visible content is validated again by Harness on append.
   */
  result(row: Invocation): ToolExecutionResult | undefined {
    if (row.result === null) return undefined
    const value: unknown = JSON.parse(row.result)
    z.object({ content: z.array(z.json()), isError: z.boolean().optional() }).parse(value)
    return value as ToolExecutionResult
  }

  /** Drain observations before releasing persistence. */
  async close(): Promise<void> {
    for (const dispose of this.disposers) dispose()
    await Promise.all(this.tails.values())
    await this.domain.close()
  }
}
