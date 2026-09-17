/** Recoverable Memory extraction and writeback jobs, independent of Run completion. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { extractedMemory, type MemoryExtractor } from './memory-extraction.ts'
import type { MemoryEmbedder } from './runtime-memory.ts'
import { resolveMemoryNamespace } from './memory-schema.ts'
import { PlatformMemory } from './memory-store.ts'
import type { MemoryContext, MemoryScope } from './memory-types.ts'
import type { MemoryManifestBinding } from './resource-types.ts'
import type { PlatformRun } from './types.ts'

const timestamp = z.iso.datetime()
const memoryContext = z.strictObject({ workspaceId: z.string().min(1), agentId: z.string().min(1), userId: z.string().nullable(), conversationId: z.string().min(1) })
const writebackRun = z.strictObject({ id: z.string().min(1), sessionId: z.string().min(1), agentId: z.string().min(1), agentVersionId: z.string().min(1),
  memoryContext })
const candidate = z.strictObject({ key: z.string().min(1), scope: z.enum(['session', 'user', 'agent']), kind: z.enum(['session_summary', 'semantic_fact']),
  content: z.string().min(1).max(32000), messageStartSeq: z.number().int().nonnegative(), messageEndSeq: z.number().int().nonnegative() })
const jobSchema = z.strictObject({ id: z.string().regex(/^memory-writeback-[a-f0-9]{32}$/), run: writebackRun, storeId: z.string().min(1),
  writeScopes: z.array(z.enum(['session', 'user', 'agent'])).max(3), allowSessionSummary: z.boolean(), allowSemanticFact: z.boolean(),
  status: z.enum(['pending', 'extracting', 'candidates_saved', 'embedding', 'committing', 'succeeded', 'failed', 'skipped']),
  attempt: z.number().int().nonnegative(), candidates: z.array(candidate).max(20), createdAt: timestamp, updatedAt: timestamp,
  completedAt: timestamp.nullable(), error: z.strictObject({ code: z.string(), message: z.string() }).nullable() })
const spec = defineDomain({ name: 'platform_memory_writeback', version: 1, tables: { jobs: domainTable(jobSchema) } })

const factSchema = z.strictObject({ id: z.string().min(1).max(300), runId: z.string().min(1).max(200),
  type: z.enum(['memory.retrieve', 'memory.extract', 'memory.write']), operationId: z.string().min(1).max(300),
  storeId: z.string().min(1).max(200), scope: z.enum(['session', 'user', 'agent']).nullable(), occurredAt: timestamp,
  durationMs: z.number().int().nonnegative().nullable(), resultCount: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'failed', 'degraded']), errorCode: z.string().min(1).max(200).nullable(),
  itemIds: z.array(z.string().min(1).max(200)).max(20),
})
const factSpec = defineDomain({ name: 'platform_memory_facts', version: 1, tables: { facts: domainTable(factSchema) } })

/** Durable writeback state projected independently of a successful Run result. */
export type MemoryWritebackJob = z.infer<typeof jobSchema>
/** Persisted Memory execution fact that the Trace projector can replay. */
export type MemoryExecutionFact = z.infer<typeof factSchema>

function jobId(runId: string, storeId: string, versionId: string): string {
  return `memory-writeback-${createHash('sha256').update(JSON.stringify([runId, storeId, versionId])).digest('hex').slice(0, 32)}`
}
/** Durable worker owner for post-Run Memory extraction. */
export class MemoryWriteback {
  private constructor(private readonly domain: Domain<typeof spec>, private readonly facts: Domain<typeof factSpec>,
    private readonly memory: PlatformMemory) {}
  /** Open writeback job storage.
   * @param storage - Platform persistence facility.
   * @param memory - durable Memory Item owner.
   * @returns writeback coordinator.
   */
  static async open(storage: DomainFacility, memory: PlatformMemory): Promise<MemoryWriteback> {
    return new MemoryWriteback(await storage.open(spec), await storage.open(factSpec), memory)
  }
  /** Close job storage after workers stop.
   * @returns completion after durable writes drain.
   */
  async close(): Promise<void> { await this.domain.close(); await this.facts.close() }
  /** Read traceable facts emitted for one Run in stable time order.
   * @param runId - durable task identity.
   * @returns detached Memory operation facts.
   */
  factsForRun(runId: string): MemoryExecutionFact[] {
    return [...this.facts.table('facts').entries()].map(([, fact]) => fact).filter(fact => fact.runId === runId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
      .map(fact => structuredClone(fact))
  }
  /** Persist a completed or degraded retrieval after the Runtime has applied authorization.
   * @param input - source-attributed retrieval result, never raw query text.
   */
  async recordRetrieval(input: Omit<MemoryExecutionFact, 'id' | 'type'>): Promise<void> {
    await this.record({ ...input, id: `${input.operationId}:${input.storeId}:${input.scope ?? 'all'}`, type: 'memory.retrieve' })
  }
  /** Persist an extraction or write result so terminal work updates the existing Run Trace.
   * @param input - durable worker outcome without candidate content.
   */
  async recordWriteback(input: Omit<MemoryExecutionFact, 'id'>): Promise<void> {
    await this.record({ ...input, id: `${input.operationId}:${input.type}:${input.storeId}:${input.scope ?? 'all'}:${input.itemIds.join(',')}`, })
  }
  private async record(input: MemoryExecutionFact): Promise<void> {
    const fact = factSchema.parse(input)
    const prior = this.facts.table('facts').get(fact.id)
    if (prior !== undefined && JSON.stringify(prior) === JSON.stringify(fact)) return
    await this.facts.table('facts').put(fact.id, fact)
  }
  /** Create one idempotent job for an eligible completed Run and binding.
   * @param run - completed Run containing trusted Memory identity.
   * @param binding - immutable Agent Version Memory policy.
   * @returns job or null when extraction is disabled or identity is absent.
   */
  async schedule(run: PlatformRun, binding: MemoryManifestBinding): Promise<MemoryWritebackJob | null> {
    if (run.memoryContext === undefined || binding.writeScopes.length === 0 || (!binding.extraction.sessionSummary && !binding.extraction.semanticFact)) return null
    const id = jobId(run.id, binding.resourceId, binding.id)
    const existing = this.domain.table('jobs').get(id)
    if (existing !== undefined) return structuredClone(existing)
    const now = new Date().toISOString()
    const row = jobSchema.parse({ id, run: { id: run.id, sessionId: run.sessionId, agentId: run.agentId, agentVersionId: run.agentVersionId,
      memoryContext: run.memoryContext }, storeId: binding.resourceId, writeScopes: binding.writeScopes, allowSessionSummary: binding.extraction.sessionSummary,
    allowSemanticFact: binding.extraction.semanticFact, status: 'pending', attempt: 0, candidates: [], createdAt: now, updatedAt: now,
    completedAt: null, error: null })
    await this.domain.table('jobs').put(id, row)
    return structuredClone(row)
  }
  /** Read a writeback job for status projection.
   * @param id - job identity.
   * @returns durable job, or null if it does not exist.
   */
  get(id: string): MemoryWritebackJob | null {
    const row = this.domain.table('jobs').get(id)
    return row === undefined ? null : structuredClone(row)
  }
  /** List writeback work for one Run without exposing another Run's jobs.
   * @param runId - durable task identity.
   * @returns detached jobs ordered by creation time.
   */
  forRun(runId: string): MemoryWritebackJob[] {
    return [...this.domain.table('jobs').entries()].map(([, job]) => job).filter(job => job.run.id === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(job => structuredClone(job))
  }
  /** Extract candidates once, persist them, then idempotently commit items and embeddings.
   * @param id - durable job identity.
   * @param extractor - configured extraction capability.
   * @param embedder - configured vector capability.
   * @param signal - cancellation for this worker attempt.
   * @returns latest durable status.
   */
  async process(id: string, extractor: MemoryExtractor, embedder: MemoryEmbedder, signal: AbortSignal): Promise<MemoryWritebackJob> {
    let job = this.required(id)
    if (job.status === 'succeeded' || job.status === 'skipped') return job
    const startedAt = Date.now()
    try {
      if (job.candidates.length === 0) {
        job = await this.replace(job, { status: 'extracting', attempt: job.attempt + 1, error: null })
        const extracted = await extractor.extract({ run: job.run, storeId: job.storeId, allowedScopes: job.writeScopes,
          allowSessionSummary: job.allowSessionSummary, allowSemanticFact: job.allowSemanticFact, signal })
        signal.throwIfAborted()
        const candidates = extracted.map(extractedMemory).filter(item => job.writeScopes.includes(item.scope)
          && (item.kind !== 'session_summary' || job.allowSessionSummary) && (item.kind !== 'semantic_fact' || job.allowSemanticFact))
          .slice(0, 20).map((item, index) => ({ key: `${job.id}:${index}`, ...item }))
        job = await this.replace(job, { status: 'candidates_saved', candidates })
        await this.recordWriteback({ runId: job.run.id, type: 'memory.extract', operationId: job.id, storeId: job.storeId,
          scope: null, occurredAt: new Date().toISOString(), durationMs: Date.now() - startedAt, resultCount: candidates.length,
          status: 'succeeded', errorCode: null, itemIds: [] })
      }
      for (const candidateItem of job.candidates) {
        signal.throwIfAborted()
        const namespace = resolveMemoryNamespace(job.storeId, candidateItem.scope as MemoryScope, job.run.memoryContext as MemoryContext)
        const item = await this.memory.write(namespace, { operationKey: candidateItem.key, kind: candidateItem.kind, content: candidateItem.content,
          source: { kind: 'run', runId: job.run.id, harnessSessionId: job.run.sessionId, agentId: job.run.agentId,
            agentVersionId: job.run.agentVersionId, messageStartSeq: candidateItem.messageStartSeq, messageEndSeq: candidateItem.messageEndSeq,
            extractorVersion: 'v1' } })
        if (item.embedding === null || item.embedding.model !== embedder.model || item.embedding.contentHash !== item.contentHash) {
          job = await this.replace(job, { status: 'embedding' })
          const vector = await embedder.embed(item.content, signal)
          await this.memory.setEmbedding(namespace, item.id, item.revision, embedder.model, vector)
        }
        await this.recordWriteback({ runId: job.run.id, type: 'memory.write', operationId: job.id, storeId: job.storeId,
          scope: candidateItem.scope, occurredAt: new Date().toISOString(), durationMs: null, resultCount: 1,
          status: 'succeeded', errorCode: null, itemIds: [item.id] })
      }
      return await this.replace(job, { status: 'succeeded', completedAt: new Date().toISOString(), error: null })
    } catch (error) {
      const current = this.required(id)
      const failed = await this.replace(current, { status: 'failed', error: { code: 'MEMORY_WRITEBACK_FAILED', message: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) } })
      await this.recordWriteback({ runId: failed.run.id, type: failed.candidates.length === 0 ? 'memory.extract' : 'memory.write',
        operationId: failed.id, storeId: failed.storeId, scope: null, occurredAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
        resultCount: 0, status: 'failed', errorCode: failed.error?.code ?? 'MEMORY_WRITEBACK_FAILED', itemIds: [] })
      return failed
    }
  }
  /** Reset a failed job without discarding durable candidates.
   * @param id - failed job identity.
   * @returns pending retry job.
   */
  async retry(id: string): Promise<MemoryWritebackJob> {
    const job = this.required(id)
    if (job.status !== 'failed') return job
    return this.replace(job, { status: job.candidates.length === 0 ? 'pending' : 'candidates_saved', error: null })
  }
  private required(id: string): MemoryWritebackJob {
    const row = this.domain.table('jobs').get(z.string().parse(id))
    if (row === undefined) throw new Error('Memory writeback job not found')
    return row
  }
  private async replace(job: MemoryWritebackJob, patch: Partial<Pick<MemoryWritebackJob, 'status' | 'attempt' | 'candidates' | 'completedAt' | 'error'>>): Promise<MemoryWritebackJob> {
    const next = jobSchema.parse({ ...job, ...patch, updatedAt: new Date().toISOString() })
    await this.domain.table('jobs').put(next.id, next)
    return structuredClone(next)
  }
}
