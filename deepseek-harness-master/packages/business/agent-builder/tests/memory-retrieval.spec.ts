import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { resolveMemoryNamespace } from '../src/memory-schema.ts'
import { LocalMemoryProvider } from '../src/memory-provider-local.ts'
import { PlatformMemory } from '../src/memory-store.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(): Promise<{ memory: PlatformMemory; provider: LocalMemoryProvider }> {
  const root = await mkdtemp(join(tmpdir(), 'memory-retrieval-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const memory = await PlatformMemory.open(new DomainFacility(ctx, { backend: 'json' }))
  cleanups.push(async () => { await memory.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { memory, provider: new LocalMemoryProvider(memory) }
}
const context = { workspaceId: 'workspace-a', agentId: 'agent-a', userId: 'user-001', conversationId: 'conversation-a' }
const source = { kind: 'run' as const, runId: 'run-a', harnessSessionId: 'session-a', agentId: 'agent-a', agentVersionId: 'version-a',
  messageStartSeq: 1, messageEndSeq: 1, extractorVersion: 'v1' }

it('ranks only matching embeddings inside the authorized namespace', async () => {
  const { memory, provider } = await fixture()
  const namespace = resolveMemoryNamespace('customer-memory', 'user', context)
  const foreign = resolveMemoryNamespace('customer-memory', 'user', { ...context, userId: 'user-002' })
  const exact = await memory.write(namespace, { operationKey: 'exact', kind: 'semantic_fact', content: 'Prefers PostgreSQL.', source })
  const weaker = await memory.write(namespace, { operationKey: 'weaker', kind: 'semantic_fact', content: 'Uses SQLite sometimes.', source })
  const forbidden = await memory.write(foreign, { operationKey: 'forbidden', kind: 'semantic_fact', content: 'Private preference.', source })
  await memory.setEmbedding(namespace, exact.id, exact.revision, 'test-embedding', [1, 0])
  await memory.setEmbedding(namespace, weaker.id, weaker.revision, 'test-embedding', [0.7, 0.7])
  await memory.setEmbedding(foreign, forbidden.id, forbidden.revision, 'test-embedding', [1, 0])

  const results = await provider.search({ namespace, model: 'test-embedding', vector: [1, 0], topK: 2, minScore: 0,
    signal: new AbortController().signal })
  expect(results.map(result => result.item.id)).toEqual([exact.id, weaker.id])
  expect(results.every(result => result.item.namespace.subjectId === 'user-001')).toBe(true)
})

it('rejects invalid vectors and excludes embeddings with a different model or dimension', async () => {
  const { memory, provider } = await fixture()
  const namespace = resolveMemoryNamespace('customer-memory', 'user', context)
  const item = await memory.write(namespace, { operationKey: 'one', kind: 'semantic_fact', content: 'Prefers PostgreSQL.', source })
  await memory.setEmbedding(namespace, item.id, item.revision, 'other-model', [1, 0])
  await expect(provider.search({ namespace, model: 'test-embedding', vector: [1, 0], topK: 1, minScore: 0,
    signal: new AbortController().signal })).resolves.toEqual([])
  await expect(provider.search({ namespace, model: 'test-embedding', vector: [], topK: 1, minScore: 0,
    signal: new AbortController().signal })).rejects.toThrow()
})
