import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { expect, it } from 'vitest'
import { Governance } from '../src/governance.ts'
import { PlatformWorkspaces } from '../src/platform-workspaces.ts'
import { withWorkspace, currentWorkspace } from '../src/workspace-context.ts'

it('persists independent workspace identities and isolates concurrent request scopes without login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-workspaces-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  let store = await PlatformWorkspaces.open(facility)
  try {
    const token = randomUUID()
    const a = await store.create('A', token)
    expect(await store.create('A', token)).toEqual(a)
    await expect(store.create('Changed', token)).rejects.toThrow('token')
    const b = await store.create('B', randomUUID())
    expect(b.id).not.toBe(a.id)
    expect(() => store.get('missing')).toThrow()
    await Promise.all([a, b].map(row => withWorkspace(row.id, async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      expect(currentWorkspace()).toBe(row.id)
    })))
    expect(currentWorkspace()).toBeUndefined()
    await store.close()
    store = await PlatformWorkspaces.open(facility)
    expect(store.list().map(row => row.name).sort()).toEqual(['A', 'B'])
    await store.close()
    const governance = await Governance.open(facility, { users: [{ id: 'admin', displayName: 'Admin', tokenHash: createHash('sha256').update('test').digest('hex') }],
      workspaces: [a, b].map(row => ({ id: row.id, name: row.name, adminId: 'admin' })) })
    try {
      expect(governance.workspace(a.id).createdAt).toBe(a.createdAt)
      expect(governance.list('admin').map(row => row.id).sort()).toEqual([a.id, b.id].sort())
      expect(governance.workspace(a.id)).not.toHaveProperty('namespaceOnly')
    } finally { await governance.close() }
    store = await PlatformWorkspaces.open(facility)
  } finally { await store.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
