import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { LocalMemoryProvider } from '../src/memory-provider-local.ts'
import { PlatformMemory } from '../src/memory-store.ts'
import { RuntimeMemory } from '../src/runtime-memory.ts'
import type { ResourceManifest } from '../src/resource-types.ts'
import type { MemoryContext } from '../src/memory-types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const context: MemoryContext = { workspaceId: 'workspace-a', agentId: 'agent-a', userId: 'user-001', conversationId: 'conversation-a' }
const source = { kind: 'run' as const, runId: 'run-a', harnessSessionId: 'session-a', agentId: 'agent-a', agentVersionId: 'version-a',
  messageStartSeq: 1, messageEndSeq: 1, extractorVersion: 'v1' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const memory = await PlatformMemory.open(new DomainFacility(ctx, { backend: 'json' }))
  cleanups.push(async () => { await memory.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return memory
}
const manifest = (storeId: string): ResourceManifest => ({ model: {} as ResourceManifest['model'], tools: [], skills: [], memoryBindings: [{
  id: 'rv-0123456789abcdef0123456789abcdef' as ResourceManifest['model']['id'], resourceId: storeId as ResourceManifest['model']['resourceId'],
  versionNumber: 1, name: 'customer-memory', spec: { kind: 'memory-store', adapter: 'local' }, specHash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
  readScopes: ['user'], writeScopes: ['user'], retrieval: { enabled: true, topK: 3, minScore: 0 }, extraction: { sessionSummary: false, semanticFact: true },
}] })

it('returns only a bound scope, keeps Item provenance, and respects the total context budget', async () => {
  const memory = await fixture()
  const storeId = 'shared-0123456789abcdef0123456789abcdef'
  const userNamespace = { workspaceId: 'workspace-a', memoryStoreId: storeId, scope: 'user' as const, subjectId: 'user-001' }
  const otherNamespace = { ...userNamespace, subjectId: 'user-002' }
  const allowed = await memory.write(userNamespace, { operationKey: 'allowed', kind: 'semantic_fact', content: 'Prefers PostgreSQL.', source })
  const forbidden = await memory.write(otherNamespace, { operationKey: 'forbidden', kind: 'semantic_fact', content: 'Private preference.', source })
  await memory.setEmbedding(userNamespace, allowed.id, allowed.revision, 'test-embedding', [1, 0])
  await memory.setEmbedding(otherNamespace, forbidden.id, forbidden.revision, 'test-embedding', [1, 0])
  const runtime = new RuntimeMemory(new LocalMemoryProvider(memory), { model: 'test-embedding', embed: async () => [1, 0] })

  const result = await runtime.retrieve(context, manifest(storeId), 'What database should I use?', new AbortController().signal)
  expect(result.items).toHaveLength(1)
  expect(result.items[0]).toMatchObject({ itemId: allowed.id, sourceRunId: 'run-a', scope: 'user' })
  expect(result.text).toContain('Prefers PostgreSQL.')
  expect(result.text).not.toContain('Private preference.')
})

it('does not call an embedder when no scoped retrieval binding exists', async () => {
  const memory = await fixture()
  const runtime = new RuntimeMemory(new LocalMemoryProvider(memory), { model: 'test', embed: async () => { throw new Error('not called') } })
  await expect(runtime.retrieve(context, undefined, 'query', new AbortController().signal)).resolves.toEqual({ items: [], text: null })
})
