import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { PlatformMemory } from '../src/memory-store.ts'
import { resolveMemoryNamespace } from '../src/memory-schema.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(): Promise<PlatformMemory> {
  const root = await mkdtemp(join(tmpdir(), 'platform-memory-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const memory = await PlatformMemory.open(new DomainFacility(ctx, { backend: 'json' }))
  cleanups.push(async () => { await memory.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return memory
}
const context = { workspaceId: 'workspace-a', agentId: 'agent-a', userId: 'user-001', conversationId: 'conversation-a' }
const source = { kind: 'run' as const, runId: 'run-a', harnessSessionId: 'session-a', agentId: 'agent-a', agentVersionId: 'version-a',
  messageStartSeq: 1, messageEndSeq: 2, extractorVersion: 'v1' }

it('only reads Memory Items from the exact resolved namespace', async () => {
  const memory = await fixture()
  const user = resolveMemoryNamespace('customer-memory', 'user', context)
  const otherUser = resolveMemoryNamespace('customer-memory', 'user', { ...context, userId: 'user-002' })
  const otherWorkspace = resolveMemoryNamespace('customer-memory', 'user', { ...context, workspaceId: 'workspace-b' })
  const item = await memory.write(user, { operationKey: 'run-a:fact:0', kind: 'semantic_fact', content: 'Prefers PostgreSQL.', source })

  expect(memory.get(user, item.id)?.content).toBe('Prefers PostgreSQL.')
  expect(memory.get(otherUser, item.id)).toBeNull()
  expect(memory.get(otherWorkspace, item.id)).toBeNull()
  expect(memory.list(otherUser)).toEqual([])
})

it('deduplicates retry writes, rejects changed receipts, expires items and retains delete tombstones', async () => {
  const memory = await fixture()
  const namespace = resolveMemoryNamespace('customer-memory', 'user', context)
  const input = { operationKey: 'run-a:fact:0', kind: 'semantic_fact' as const, content: 'Prefers PostgreSQL.', source }
  const first = await memory.write(namespace, input)
  const duplicate = await memory.write(namespace, input)
  expect(duplicate).toEqual(first)
  await expect(memory.write(namespace, { ...input, content: 'Prefers SQLite.' })).rejects.toThrow('operation key')
  const expiring = await memory.write(namespace, { ...input, operationKey: 'run-a:fact:1', expiresAt: '2020-01-01T00:00:00.000Z' })
  expect(memory.get(namespace, expiring.id)).toBeNull()
  const deleted = await memory.delete(namespace, first.id, first.revision, 'User requested removal')
  expect(deleted.status).toBe('deleted')
  expect(memory.get(namespace, first.id)).toBeNull()
  expect((await memory.write(namespace, input)).status).toBe('deleted')
})
