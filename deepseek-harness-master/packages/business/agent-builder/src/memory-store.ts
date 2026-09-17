/** Durable scoped Memory Items with idempotent writes and tombstone deletion. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { memoryNamespaceKey, memoryNamespaceSchema } from './memory-schema.ts'
import type { MemoryNamespace } from './memory-types.ts'
import { RegistryError } from './registry.ts'

const timestamp = z.iso.datetime()
const itemKind = z.enum(['session_summary', 'semantic_fact'])
const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), runId: z.string().min(1).max(200), harnessSessionId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200), agentVersionId: z.string().min(1).max(200), messageStartSeq: z.number().int().nonnegative(),
    messageEndSeq: z.number().int().nonnegative(), extractorVersion: z.string().min(1).max(100) })
    .refine(value => value.messageEndSeq >= value.messageStartSeq, 'Memory source sequence range is invalid'),
  z.strictObject({ kind: z.literal('manual'), actorId: z.string().min(1).max(200), reason: z.string().max(1000) }),
  z.strictObject({ kind: z.literal('legacy_import'), actorId: z.string().min(1).max(200), legacyKey: z.string().min(1).max(200) }),
])
const inputSchema = z.strictObject({ operationKey: z.string().min(1).max(200), kind: itemKind, content: z.string().trim().min(1).max(32000),
  source: sourceSchema, expiresAt: timestamp.nullable().optional() })
const embeddingSchema = z.strictObject({ model: z.string().trim().min(1).max(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  values: z.array(z.number().finite()).min(1).max(4096) })
const itemSchema = inputSchema.extend({ id: z.string().regex(/^memory-[a-f0-9]{32}$/), namespace: memoryNamespaceSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp, updatedAt: timestamp, status: z.enum(['active', 'deleted']),
  revision: z.number().int().positive(), deletedAt: timestamp.nullable(), deletionReason: z.string().max(1000).nullable(),
  expiresAt: timestamp.nullable(), embedding: embeddingSchema.nullable() })
const spec = defineDomain({ name: 'platform_memory', version: 1, tables: { items: domainTable(itemSchema) } })

/** A persistently attributable Memory Item. */
export type MemoryItem = z.infer<typeof itemSchema>
/** Input for an idempotent Memory Item write. */
export type MemoryItemInput = z.input<typeof inputSchema>
/** Embedding persisted beside the exact content revision it represents. */
export type MemoryEmbedding = z.infer<typeof embeddingSchema>

function contentHash(content: string): string { return createHash('sha256').update(content).digest('hex') }
function itemId(namespace: MemoryNamespace, operationKey: string): string {
  return `memory-${createHash('sha256').update(JSON.stringify([memoryNamespaceKey(namespace), operationKey])).digest('hex').slice(0, 32)}`
}
function visible(item: MemoryItem, at: number): boolean {
  return item.status === 'active' && (item.expiresAt === null || Date.parse(item.expiresAt) > at)
}

/** Persistent owner of scoped Memory Items. */
export class PlatformMemory {
  private constructor(private readonly domain: Domain<typeof spec>) {}
  /** Open Memory Item storage.
   * @param storage - Platform persistence facility.
   * @returns durable Memory Item service.
   */
  static async open(storage: DomainFacility): Promise<PlatformMemory> { return new PlatformMemory(await storage.open(spec)) }
  /** Release the Memory Item storage domain.
   * @returns completion after durable writes have drained.
   */
  async close(): Promise<void> { await this.domain.close() }
  /** List visible Memory Items inside one already-authorized namespace.
   * @param namespace - exact Workspace, Store, scope and subject namespace.
   * @param limit - bounded result count.
   * @param now - injected clock for deterministic expiration tests.
   * @returns newest visible items only.
   */
  list(namespace: MemoryNamespace, limit = 100, now = Date.now()): MemoryItem[] {
    const resolved = memoryNamespaceSchema.parse(namespace)
    const key = memoryNamespaceKey(resolved)
    return [...this.domain.table('items').entries()].map(([, item]) => item)
      .filter(item => memoryNamespaceKey(item.namespace) === key && visible(item, now))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, z.number().int().min(1).max(100).parse(limit)).map(item => structuredClone(item))
  }
  /** Read one visible item without allowing an item ID to cross namespace boundaries.
   * @param namespace - exact authorized namespace.
   * @param id - opaque item identity.
   * @param now - injected clock for deterministic expiration tests.
   * @returns visible item or null.
   */
  get(namespace: MemoryNamespace, id: string, now = Date.now()): MemoryItem | null {
    const item = this.domain.table('items').get(z.string().parse(id))
    if (item === undefined || memoryNamespaceKey(item.namespace) !== memoryNamespaceKey(memoryNamespaceSchema.parse(namespace)) || !visible(item, now)) return null
    return structuredClone(item)
  }
  /** Create one Item exactly once for its namespace and operation key.
   * @param namespace - exact authorized namespace.
   * @param input - content and attributable source.
   * @returns stored item, including a stable id for retry receipts.
   */
  async write(namespace: MemoryNamespace, input: MemoryItemInput): Promise<MemoryItem> {
    const resolved = memoryNamespaceSchema.parse(namespace)
    const value = inputSchema.parse(input)
    const id = itemId(resolved, value.operationKey)
    const hash = contentHash(value.content)
    const previous = this.domain.table('items').get(id)
    if (previous !== undefined) {
      if (previous.contentHash !== hash || JSON.stringify(previous.source) !== JSON.stringify(value.source)) {
        throw new RegistryError('conflict', 'Memory operation key was reused with different content')
      }
      return structuredClone(previous)
    }
    const now = new Date().toISOString()
    const row = itemSchema.parse({ ...value, id, namespace: resolved, contentHash: hash, createdAt: now, updatedAt: now,
      status: 'active', revision: 1, deletedAt: null, deletionReason: null, expiresAt: value.expiresAt ?? null, embedding: null })
    await this.domain.table('items').put(id, row)
    return structuredClone(row)
  }
  /** Attach an embedding only to the current active content revision.
   * @param namespace - exact authorized namespace.
   * @param id - visible item identity.
   * @param revision - expected Item revision.
   * @param model - configured embedding model identifier.
   * @param values - finite embedding dimensions.
   * @returns updated item with a content-hash-bound embedding.
   */
  async setEmbedding(namespace: MemoryNamespace, id: string, revision: number, model: string, values: readonly number[]): Promise<MemoryItem> {
    const resolved = memoryNamespaceSchema.parse(namespace)
    const expectedRevision = z.number().int().positive().parse(revision)
    const stored = this.domain.table('items').get(z.string().parse(id))
    if (stored === undefined || memoryNamespaceKey(stored.namespace) !== memoryNamespaceKey(resolved) || stored.status !== 'active') {
      throw new RegistryError('not-found', 'Memory Item not found')
    }
    if (stored.revision !== expectedRevision) throw new RegistryError('conflict', 'Memory Item changed; reload before embedding')
    const embedding = embeddingSchema.parse({ model, values: [...values], contentHash: stored.contentHash })
    const next = itemSchema.parse({ ...stored, embedding, revision: stored.revision + 1, updatedAt: new Date().toISOString() })
    await this.domain.table('items').put(next.id, next)
    return structuredClone(next)
  }
  /** Tombstone a Memory Item so pending retries cannot silently recreate it.
   * @param namespace - exact authorized namespace.
   * @param id - visible item identity.
   * @param revision - optimistic concurrency revision.
   * @param reason - bounded operator reason.
   * @returns tombstoned item.
   */
  async delete(namespace: MemoryNamespace, id: string, revision: number, reason: string): Promise<MemoryItem> {
    const resolved = memoryNamespaceSchema.parse(namespace)
    const expectedRevision = z.number().int().positive().parse(revision)
    const deletionReason = z.string().trim().min(1).max(1000).parse(reason)
    const stored = this.domain.table('items').get(z.string().parse(id))
    if (stored === undefined || memoryNamespaceKey(stored.namespace) !== memoryNamespaceKey(resolved)) throw new RegistryError('not-found', 'Memory Item not found')
    if (stored.revision !== expectedRevision) throw new RegistryError('conflict', 'Memory Item changed; reload before deleting')
    if (stored.status === 'deleted') return structuredClone(stored)
    const now = new Date().toISOString()
    const next = itemSchema.parse({ ...stored, status: 'deleted', revision: stored.revision + 1, updatedAt: now, deletedAt: now,
      deletionReason })
    await this.domain.table('items').put(next.id, next)
    return structuredClone(next)
  }
}
