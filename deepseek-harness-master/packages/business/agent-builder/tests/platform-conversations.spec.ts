import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { PlatformConversations } from '../src/platform-conversations.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(): Promise<PlatformConversations> {
  const root = await mkdtemp(join(tmpdir(), 'platform-conversations-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const conversations = await PlatformConversations.open(new DomainFacility(ctx, { backend: 'json' }))
  cleanups.push(async () => { await conversations.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return conversations
}

it('only resolves a business conversation for its authenticated user and Workspace', async () => {
  const conversations = await fixture()
  const conversation = await conversations.create('workspace-a', 'user-001', randomUUID())

  expect(conversations.get('workspace-a', 'user-001', conversation.id)).toMatchObject({ id: conversation.id })
  expect(() => conversations.get('workspace-a', 'user-002', conversation.id)).toThrow('not found')
  expect(() => conversations.get('workspace-b', 'user-001', conversation.id)).toThrow('not found')
})

it('creates a deterministic independent conversation for each admission token', async () => {
  const conversations = await fixture()
  const token = randomUUID()
  const [first, duplicate] = await Promise.all([conversations.create('workspace-a', 'user-001', token), conversations.create('workspace-a', 'user-001', token)])
  const second = await conversations.create('workspace-a', 'user-001', randomUUID())

  expect(first.id).toBe(duplicate.id)
  expect(second.id).not.toBe(first.id)
})
