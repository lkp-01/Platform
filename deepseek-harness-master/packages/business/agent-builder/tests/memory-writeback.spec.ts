import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { PlatformMemory } from '../src/memory-store.ts'
import { MemoryWriteback } from '../src/memory-writeback.ts'
import type { PlatformRun } from '../src/types.ts'
import type { MemoryManifestBinding } from '../src/resource-types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-writeback-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const memory = await PlatformMemory.open(facility)
  const writeback = await MemoryWriteback.open(facility, memory)
  cleanups.push(async () => { await writeback.close(); await memory.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { memory, writeback }
}
const run = { id: 'run-a', sessionId: 'session-a', agentId: 'agent-a', agentVersionId: 'version-a', memoryContext: {
  workspaceId: 'workspace-a', agentId: 'agent-a', userId: 'user-001', conversationId: 'conversation-a' } } as PlatformRun
const binding = { id: 'rv-0123456789abcdef0123456789abcdef', resourceId: 'shared-0123456789abcdef0123456789abcdef', versionNumber: 1,
  name: 'customer-memory', spec: { kind: 'memory-store', adapter: 'local' }, specHash: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
  readScopes: ['user'], writeScopes: ['user'], retrieval: { enabled: true, topK: 3, minScore: 0 },
  extraction: { sessionSummary: false, semanticFact: true } } as MemoryManifestBinding

it('persists extraction candidates before idempotently writing and embedding Items', async () => {
  const { memory, writeback } = await fixture()
  const job = await writeback.schedule(run, binding)
  expect(job).not.toBeNull()
  const first = await writeback.process(job!.id, { extract: async () => [{ scope: 'user', kind: 'semantic_fact', content: 'Prefers PostgreSQL.', messageStartSeq: 4, messageEndSeq: 4 }] },
    { model: 'test-embedding', embed: async () => [1, 0] }, new AbortController().signal)
  const duplicate = await writeback.process(job!.id, { extract: async () => { throw new Error('must not extract twice') } },
    { model: 'test-embedding', embed: async () => { throw new Error('must not embed twice') } }, new AbortController().signal)
  const items = memory.list({ workspaceId: 'workspace-a', memoryStoreId: binding.resourceId, scope: 'user', subjectId: 'user-001' })
  expect(first.status).toBe('succeeded')
  expect(duplicate.status).toBe('succeeded')
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ content: 'Prefers PostgreSQL.', embedding: { model: 'test-embedding' }, source: { runId: 'run-a' } })
  expect(writeback.factsForRun(run.id)).toMatchObject([
    { type: 'memory.extract', storeId: binding.resourceId, resultCount: 1, status: 'succeeded' },
    { type: 'memory.write', storeId: binding.resourceId, scope: 'user', resultCount: 1, itemIds: [items[0]!.id] },
  ])
})

it('retains a failed job and allows an explicit retry without altering the Run', async () => {
  const { writeback } = await fixture()
  const job = await writeback.schedule(run, binding)
  const failed = await writeback.process(job!.id, { extract: async () => { throw new Error('extractor unavailable') } },
    { model: 'test', embed: async () => [1] }, new AbortController().signal)
  expect(failed).toMatchObject({ status: 'failed', error: { code: 'MEMORY_WRITEBACK_FAILED' } })
  expect(await writeback.retry(job!.id)).toMatchObject({ status: 'pending', error: null })
  await expect(writeback.process(job!.id, { extract: async () => [] }, { model: 'test', embed: async () => [1] },
    new AbortController().signal)).resolves.toMatchObject({ status: 'succeeded' })
  expect(writeback.factsForRun(run.id)).toMatchObject([
    { type: 'memory.extract', status: 'succeeded', errorCode: null },
  ])
})
