import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { AgentRegistry } from '../src/registry.ts'
import type { RegistryAgentInput, RegistryWorkspace } from '../src/types.ts'

const workspace: RegistryWorkspace = { id: 'redis', name: 'Redis Team', ownerTeamId: 'redis-team', ownerTeamName: 'Redis Team', accessMode: 'shared-host' }
const input: RegistryAgentInput = { name: 'SRE Agent', description: 'Redis incident assistant', harnessId: 'deepseek-harness', ownerTeamId: 'redis-team',
  prompt: 'Literal {{user}}\n你好', model: { provider: 'demo', model: 'one' }, toolIds: [], tags: ['sre'] }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(root?: string) {
  const path = root ?? await mkdtemp(join(tmpdir(), 'registry-'))
  if (root === undefined) cleanups.push(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const registry = await AgentRegistry.open(facility, workspace)
  const close = async () => { await registry.close(); await backend.close(); await ctx.fiber.dispose() }
  cleanups.push(close)
  return { path, registry, close }
}

describe('platform Agent Registry', () => {
  it('creates once across concurrent retries, retains identity after edit, and survives reopening', async () => {
    const { registry, path, close } = await fixture()
    const token = randomUUID()
    const results = await Promise.all(Array.from({ length: 4 }, () => registry.create('redis', input, token)))
    expect(new Set(results.map(value => value.id)).size).toBe(1)
    const first = results[0]!
    const edited = await registry.update('redis', first.id, 1, { ...input, name: 'Renamed', prompt: 'New draft' })
    expect(edited).toMatchObject({ id: first.id, revision: 2, name: 'Renamed' })
    expect(await registry.create('redis', input, token)).toEqual(edited)
    await expect(registry.create('redis', { ...input, name: 'Different' }, token)).rejects.toMatchObject({ code: 'conflict' })
    expect(registry.list({ workspaceId: 'redis' }).items[0]).not.toHaveProperty('prompt')
    await close()
    const reopened = await fixture(path)
    expect(reopened.registry.get('redis', first.id)).toEqual(edited)
  })

  it('rejects stale writes and foreign scopes, archives without deleting the draft, and restores the same ID', async () => {
    const { registry } = await fixture()
    const agent = await registry.create('redis', input, randomUUID())
    const outcomes = await Promise.allSettled([
      registry.update('redis', agent.id, 1, { ...input, name: 'A' }),
      registry.update('redis', agent.id, 1, { ...input, name: 'B' }),
    ])
    expect(outcomes.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(() => registry.get('other-team', agent.id)).toThrow('Workspace not found')
    await expect(registry.create('redis', { ...input, ownerTeamId: 'other' }, randomUUID())).rejects.toMatchObject({ code: 'owner-invalid' })
    const archived = await registry.setArchived('redis', agent.id, 2, true)
    expect(registry.list({ workspaceId: 'redis' }).items).toEqual([])
    expect(registry.list({ workspaceId: 'redis', lifecycle: 'archived' }).total).toBe(1)
    await expect(registry.update('redis', agent.id, archived.revision, input)).rejects.toMatchObject({ code: 'archived' })
    expect(await registry.setArchived('redis', agent.id, 2, true)).toEqual(archived)
    const restored = await registry.setArchived('redis', agent.id, archived.revision, false)
    expect(restored).toMatchObject({ id: agent.id, lifecycle: 'active', prompt: input.prompt })
  })

  it('keeps pagination stable and legacy imports idempotent after editing', async () => {
    const { registry } = await fixture()
    const token = randomUUID()
    const old = await registry.create('redis', input, token, 'agent-legacy')
    await registry.update('redis', old.id, 1, { ...input, description: 'edited' })
    expect((await registry.create('redis', input, token, 'agent-legacy')).description).toBe('edited')
    await registry.create('redis', { ...input, name: 'Data' }, randomUUID())
    const first = registry.list({ workspaceId: 'redis', limit: 1 })
    const second = registry.list({ workspaceId: 'redis', cursor: first.nextCursor!, limit: 1 })
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id)
    expect(second.nextCursor).toBeNull()
    expect(registry.list({ workspaceId: 'redis', query: 'Data' }).total).toBe(1)
  })
})
