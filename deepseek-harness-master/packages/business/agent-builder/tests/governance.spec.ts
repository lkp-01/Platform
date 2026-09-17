import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Governance } from '../src/governance.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(existingPath?: string) {
  const path = existingPath ?? await mkdtemp(join(tmpdir(), 'governance-'))
  if (existingPath === undefined) cleanup.push(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path)
  ctx.storage.backend.register('json', backend)
  const storage = new DomainFacility(ctx, { backend: 'json' })
  const config = {
    users: ['admin', 'developer', 'user', 'finance'].map(id => ({ id, displayName: id, tokenHash: digest(id.padEnd(40, '-')) })),
    workspaces: [{ id: 'sales', name: 'Sales', adminId: 'admin' }, { id: 'finance', name: 'Finance', adminId: 'finance' }],
    sessionHours: 8,
  }
  const governance = await Governance.open(storage, config)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true; await governance.close(); await backend.close(); await ctx.fiber.dispose()
  }
  cleanup.push(close)
  return { governance, config, path, close }
}

it('authenticates independent credentials and expires or revokes browser sessions', async () => {
  const { governance } = await fixture()
  expect(() => governance.login('wrong')).toThrow()
  const session = await governance.login('admin'.padEnd(40, '-'))
  expect(governance.authenticate(session.token)).toBe('admin')
  expect(governance.authenticate(session.token, Date.now() + 9 * 3600000)).toBeUndefined()
  await governance.logout(session.token)
  expect(governance.authenticate(session.token)).toBeUndefined()
})

it('isolates memberships and enforces fixed roles without accepting client roles', async () => {
  const { governance } = await fixture()
  await governance.setMember('admin', 'sales', 'developer', 'developer', 0)
  await governance.setMember('admin', 'sales', 'user', 'user', 0)
  expect(governance.list('developer').map(row => row.id)).toEqual(['sales'])
  expect(governance.authorize('developer', 'sales', 'edit')).toBe('developer')
  expect(() => governance.authorize('developer', 'sales', 'admin')).toThrow()
  expect(() => governance.authorize('user', 'sales', 'edit')).toThrow()
  expect(() => governance.authorize('user', 'finance', 'read')).toThrow()
  expect(() => governance.authorize('shared-host', 'sales', 'run')).toThrow()
  await expect(governance.setMember('developer', 'sales', 'user', 'admin', 1)).rejects.toThrow()
  await governance.setMember('admin', 'sales', 'user', null, 1)
  expect(() => governance.authorize('user', 'sales', 'run')).toThrow()
})

it('retains an administrator across concurrent removals and uses revision locks', async () => {
  const { governance } = await fixture()
  await governance.setMember('admin', 'sales', 'developer', 'admin', 0)
  const results = await Promise.allSettled([
    governance.setMember('admin', 'sales', 'admin', null, 1),
    governance.setMember('developer', 'sales', 'developer', null, 1),
  ])
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  const remaining = governance.list('admin').length ? 'admin' : 'developer'
  expect(governance.members(remaining, 'sales').filter(row => row.role === 'admin')).toHaveLength(1)
  await expect(governance.updateWorkspace(remaining, 'sales', 8, 'Renamed', 'active')).rejects.toThrow()
  await governance.updateWorkspace(remaining, 'sales', 1, 'Archived', 'archived')
  expect(governance.authorize(remaining, 'sales', 'read')).toBe('admin')
  expect(() => governance.authorize(remaining, 'sales', 'run')).toThrow()
  expect(governance.audit(remaining, 'sales').length).toBeGreaterThan(0)
})

it('preserves removed bootstrap membership and detects stale edits after rejoining', async () => {
  const first = await fixture()
  await first.governance.setMember('admin', 'sales', 'developer', 'admin', 0)
  await first.governance.setMember('developer', 'sales', 'admin', null, 1)
  await first.close()
  const second = await fixture(first.path)
  expect(second.governance.list('admin')).toEqual([])
  expect(second.governance.authorize('developer', 'sales', 'admin')).toBe('admin')
  await second.governance.setMember('developer', 'sales', 'admin', 'user', 0)
  const member = second.governance.members('developer', 'sales').find(row => row.userId === 'admin')!
  expect(member.revision).toBeGreaterThan(1)
  await expect(second.governance.setMember('developer', 'sales', 'admin', 'admin', 1)).rejects.toThrow()
})

it('invalidates issued sessions when the operator rotates a credential', async () => {
  const { governance } = await fixture()
  const session = await governance.login('admin'.padEnd(40, '-'))
  governance.config.users.find(user => user.id === 'admin')!.tokenHash = digest('rotated'.padEnd(40, '-'))
  expect(governance.authenticate(session.token)).toBeUndefined()
})
