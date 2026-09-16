import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { AgentRegistry } from '../src/registry.ts'
import { AgentVersions } from '../src/versions.ts'
import { AgentDeployments } from '../src/deployments.ts'
import { prepareVersionPreset } from '../src/version-preset.ts'
import type { RegistryAgentInput } from '../src/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const input: RegistryAgentInput = { name: 'SRE', prompt: 'Literal {{customer}}\n你好', description: '', tags: [],
  harnessId: 'deepseek-harness', model: { provider: 'demo', model: 'one' }, toolIds: ['order_query'], ownerTeamId: 'team' }
const validate = async () => {}
async function fixture(path?: string) {
  const root = path ?? await mkdtemp(join(tmpdir(), 'agent-version-'))
  if (path === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  const units = new Map<string, KvUnit>()
  const open = backend.kv.open.bind(backend.kv)
  vi.spyOn(backend.kv, 'open').mockImplementation(async (descriptor) => {
    const unit = await open(descriptor)
    units.set(descriptor.name, unit)
    return unit
  })
  ctx.storage.backend.register('json', backend)
  const storage = new DomainFacility(ctx, { backend: 'json' })
  const registry = await AgentRegistry.open(storage, { id: 'ws', name: 'WS', ownerTeamId: 'team', ownerTeamName: 'Team', accessMode: 'shared-host' })
  const versions = await AgentVersions.open(storage, registry)
  const deployments = await AgentDeployments.open(storage, registry, versions)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await deployments.close(); await versions.close(); await registry.close(); await backend.close(); await ctx.fiber.dispose()
  }
  cleanup.push(close)
  return { root, registry, versions, deployments, close, units }
}

describe('immutable Agent versions and default deployment', () => {
  it('does not publish failed writes and safely retries the same version and activation requests', async () => {
    const { registry, versions, deployments, units } = await fixture()
    const agent = await registry.create('ws', input, randomUUID())
    const token = randomUUID()
    const versionUnit = [...units.entries()].find(([name]) => name.includes('platform_agent_versions'))![1]
    vi.spyOn(versionUnit, 'putRecord').mockRejectedValueOnce(new Error('disk full'))
    await expect(versions.create('ws', agent.id, 1, token, '', validate)).rejects.toThrow('disk full')
    expect(versions.list('ws', agent.id, 0).items).toHaveLength(0)
    const v1 = await versions.create('ws', agent.id, 1, token, '', validate)
    expect(v1.versionNumber).toBe(1)
    const deploymentUnit = [...units.entries()].find(([name]) => name.includes('platform_agent_deployments'))![1]
    vi.spyOn(deploymentUnit, 'putRecord').mockRejectedValueOnce(new Error('disk full'))
    await expect(deployments.activate('ws', agent.id, v1.id, 0, token, 'deploy', validate)).rejects.toThrow('disk full')
    expect(deployments.get('ws', agent.id)).toBeNull()
    expect(deployments.history('ws', agent.id, 0).items).toHaveLength(0)
    expect(await deployments.activate('ws', agent.id, v1.id, 0, token, 'deploy', validate)).toMatchObject({ revision: 1, versionId: v1.id })
  })

  it('serializes archival after a version already being saved, then rejects fresh version requests', async () => {
    const { registry, versions } = await fixture()
    const agent = await registry.create('ws', input, randomUUID())
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const saving = versions.create('ws', agent.id, 1, randomUUID(), '', async () => { entered.resolve(undefined); await release.promise })
    await entered.promise
    const archiving = registry.setArchived('ws', agent.id, 1, true)
    release.resolve(undefined)
    expect((await saving).sourceRevision).toBe(1)
    const archived = await archiving
    await expect(versions.create('ws', agent.id, archived.revision, randomUUID(), '', validate)).rejects.toThrow('Restore')
  })
  it('allocates concurrent versions once, preserves literal snapshots and survives reopening', async () => {
    const { registry, versions, deployments, root, close } = await fixture()
    const agent = await registry.create('ws', input, randomUUID())
    const token = randomUUID()
    const copies = await Promise.all(Array.from({ length: 4 }, () => versions.create('ws', agent.id, 1, token, 'first', validate)))
    expect(new Set(copies.map(row => row.id)).size).toBe(1)
    const v1 = copies[0]!
    expect(v1.snapshot.prompt).toBe(input.prompt)
    expect(deployments.get('ws', agent.id)).toBeNull()
    const edited = await registry.update('ws', agent.id, 1, { ...input, prompt: 'Prompt B', toolIds: [] })
    const [v2, v3] = await Promise.all([randomUUID(), randomUUID()].map(id => versions.create('ws', agent.id, edited.revision, id, '', validate)))
    expect([v2!.versionNumber, v3!.versionNumber]).toEqual([2, 3])
    expect(await versions.create('ws', agent.id, 1, token, 'first', validate)).toEqual(v1)
    await expect(versions.create('ws', agent.id, 2, token, 'first', validate)).rejects.toThrow('token')
    v1.snapshot.prompt = 'tampered in caller'
    expect(versions.get('ws', agent.id, v1.id).snapshot.prompt).toBe(input.prompt)
    await close()
    const reopened = await fixture(root)
    expect(reopened.versions.list('ws', agent.id, 0).items.map(v => v.versionNumber)).toEqual([3, 2, 1])
    expect(reopened.versions.get('ws', agent.id, copies[0]!.id).snapshot.prompt).toBe(input.prompt)
    expect(() => reopened.versions.get('foreign', agent.id, v2!.id)).toThrow('Workspace')
  })

  it('keeps the prior deployment on preparation failure and records rollback atomically', async () => {
    const { registry, versions, deployments, root, close } = await fixture()
    const agent = await registry.create('ws', input, randomUUID())
    const v1 = await versions.create('ws', agent.id, 1, randomUUID(), '', validate)
    const v2 = await versions.create('ws', agent.id, 1, randomUUID(), '', validate)
    const prepare = async (version: typeof v1) => { await prepareVersionPreset(join(root, 'presets'), version) }
    const first = await deployments.activate('ws', agent.id, v1.id, 0, randomUUID(), 'deploy', prepare)
    await expect(deployments.activate('ws', agent.id, v2.id, 1, randomUUID(), 'deploy', async () => { throw new Error('model unavailable') })).rejects.toThrow('unavailable')
    expect(deployments.get('ws', agent.id)).toEqual(first)
    const attempts = await Promise.allSettled([randomUUID(), randomUUID()].map(token => deployments.activate('ws', agent.id, v2.id, 1, token, 'deploy', prepare)))
    expect(attempts.map(v => v.status).sort()).toEqual(['fulfilled', 'rejected'])
    const token = randomUUID()
    const rollback = await deployments.activate('ws', agent.id, v1.id, 2, token, 'rollback', prepare)
    expect(rollback).toMatchObject({ revision: 3, versionId: v1.id, previousVersionId: v2.id, action: 'rollback' })
    expect(await deployments.activate('ws', agent.id, v1.id, 2, token, 'rollback', prepare)).toEqual(rollback)
    await close()
    const reopened = await fixture(root)
    expect(reopened.deployments.get('ws', agent.id)).toEqual(rollback)
    expect(reopened.deployments.history('ws', agent.id, 0).items).toHaveLength(3)
  })

  it('rejects stale drafts, archived writes, foreign versions and modified execution artifacts', async () => {
    const { registry, versions, deployments, root } = await fixture()
    const agent = await registry.create('ws', input, randomUUID())
    const other = await registry.create('ws', input, randomUUID())
    const v1 = await versions.create('ws', agent.id, 1, randomUUID(), '', validate)
    const presetRoot = join(root, 'presets')
    await prepareVersionPreset(presetRoot, v1)
    await writeFile(join(presetRoot, v1.id, 'agent.cordis.yml'), '[]')
    await expect(prepareVersionPreset(presetRoot, v1)).rejects.toThrow('modified')
    await expect(deployments.activate('ws', other.id, v1.id, 0, randomUUID(), 'deploy', validate)).rejects.toThrow('not found')
    await registry.update('ws', agent.id, 1, { ...input, name: 'Renamed' })
    await expect(versions.create('ws', agent.id, 1, randomUUID(), '', validate)).rejects.toThrow('changed')
    await registry.setArchived('ws', agent.id, 2, true)
    await expect(versions.create('ws', agent.id, 3, randomUUID(), '', validate)).rejects.toThrow('Restore')
    await expect(deployments.activate('ws', agent.id, v1.id, 0, randomUUID(), 'deploy', validate)).rejects.toThrow('Restore')
    expect(versions.get('ws', agent.id, v1.id).snapshot.prompt).toBe(input.prompt)
  })
})
