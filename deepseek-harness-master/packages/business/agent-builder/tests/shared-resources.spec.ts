import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { SharedResources } from '../src/shared-resources.ts'
import { AgentRegistry } from '../src/registry.ts'
import { AgentVersions } from '../src/versions.ts'
import { renderVersion } from '../src/version-preset.ts'
import { snapshotHash } from '../src/version-schema.ts'
import type { ResourceInput, ResourceRef } from '../src/resource-types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(path?: string) {
  const root = path ?? await mkdtemp(join(tmpdir(), 'shared-resources-'))
  if (path === undefined) cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const storage = new DomainFacility(ctx, { backend: 'json' })
  const resources = await SharedResources.open(storage, 'shared')
  const registry = await AgentRegistry.open(storage, { id: 'shared', name: 'Shared', ownerTeamId: 'team', ownerTeamName: 'Team', accessMode: 'shared-host' })
  const versions = await AgentVersions.open(storage, registry)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await versions.close(); await registry.close(); await resources.close(); await backend.close(); await ctx.fiber.dispose()
  }
  cleanups.push(close)
  const publish = async (name: string, spec: ResourceInput['spec']): Promise<ResourceRef> => {
    const row = await resources.create({ name, description: '', ownerTeamId: 'platform', spec }, randomUUID())
    const version = await resources.publish(row.id, row.revision, randomUUID())
    return { resourceId: row.id, versionId: version.id }
  }
  return { root, close, resources, registry, versions, publish }
}

describe('shared resource lifecycle', () => {
  it('seeds catalogs concurrently without republishing or resetting administrator changes', async () => {
    const { resources } = await fixture()
    const catalog = { routableProviders: ['demo'], failures: [], default: { provider: 'demo', model: 'one' }, groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'one', name: 'One' }] }] }
    await Promise.all([resources.seed(catalog, 'team'), resources.seed(catalog, 'team')])
    const initial = resources.list()
    expect(initial).toHaveLength(12)
    expect(initial.every(row => row.versions.length === 1)).toBe(true)
    const tool = initial.find(row => row.name === 'order_query')!
    await resources.setStatus(tool.id, tool.revision, 'disabled')
    await resources.seed(catalog, 'team')
    expect(resources.get(tool.id).status).toBe('disabled')
    expect(resources.list()).toHaveLength(12)
  })
  it('publishes once across retries, preserves old content after editing and survives restart', async () => {
    const { resources, root, close } = await fixture()
    const input: ResourceInput = { name: 'triage', description: '', ownerTeamId: 'sre', spec: { kind: 'skill', content: 'Inspect first' } }
    const createToken = randomUUID()
    const rows = await Promise.all([1, 2].map(() => resources.create(input, createToken)))
    expect(rows[0]!.id).toBe(rows[1]!.id)
    const row = rows[0]!
    const token = randomUUID()
    const copies = await Promise.all([1, 2].map(() => resources.publish(row.id, 1, token)))
    expect(copies[0]).toEqual(copies[1])
    await resources.update(row.id, 2, { ...input, spec: { kind: 'skill', content: 'Inspect then summarize' } })
    const second = await resources.publish(row.id, 3, randomUUID())
    expect(second.versionNumber).toBe(2)
    expect((await resources.publish(row.id, 1, token)).spec).toEqual(input.spec)
    await expect(resources.publish(row.id, 3, token)).rejects.toThrow('token')
    await close()
    const reopened = await fixture(root)
    expect(reopened.resources.get(row.id).versions.map(version => version.spec)).toEqual([input.spec, second.spec])
  })

  it('rejects stale edits, duplicate names, missing versions, wrong kinds and duplicate operations', async () => {
    const { resources, publish } = await fixture()
    const model = await publish('model', { kind: 'model', provider: 'demo', model: 'one' })
    const tool = await publish('orders', { kind: 'tool', operation: 'order_query' })
    const alias = await publish('orders-alias', { kind: 'tool', operation: 'order_query' })
    const input = { name: 'orders', description: '', ownerTeamId: 'team', spec: { kind: 'tool' as const, operation: 'order_query' } }
    await expect(resources.create(input, randomUUID())).rejects.toThrow('name')
    await expect(resources.update(tool.resourceId, 1, input)).rejects.toThrow('changed')
    expect(() => resources.resolve({ model: tool, tools: [], skills: [] })).toThrow('kind')
    expect(() => resources.resolve({ model, tools: [tool, alias], skills: [] })).toThrow('Duplicate')
    expect(() => resources.resolve({ model: { ...model, versionId: tool.versionId }, tools: [], skills: [] })).toThrow('missing')
  })

  it('allows deprecated existing references and blocks disabled dependencies without hiding history', async () => {
    const { resources, publish } = await fixture()
    const model = await publish('model', { kind: 'model', provider: 'demo', model: 'one' })
    const tool = await publish('orders', { kind: 'tool', operation: 'order_query' })
    const refs = { model, tools: [tool], skills: [] }
    const manifest = resources.resolve(refs)
    await resources.setStatus(tool.resourceId, 2, 'deprecated')
    expect(() => resources.resolve(refs)).toThrow('deprecated')
    expect(() =>{  resources.assertAvailable(manifest) }).not.toThrow()
    await resources.setStatus(tool.resourceId, 3, 'disabled')
    expect(() =>{  resources.assertAvailable(manifest) }).toThrow('disabled')
    expect(resources.get(tool.resourceId).versions).toHaveLength(1)
  })

  it('pins shared contents independently for two Agents and includes Skill instructions in the Harness composition', async () => {
    const { resources, registry, versions, publish } = await fixture()
    const model = await publish('model', { kind: 'model', provider: 'demo', model: 'one' })
    const tool = await publish('orders', { kind: 'tool', operation: 'order_query' })
    const skill = await publish('triage', { kind: 'skill', content: 'Ask for evidence before conclusions.' })
    const refs = { model, tools: [tool], skills: [skill] }
    const input = { name: 'SRE', description: '', ownerTeamId: 'team', harnessId: 'deepseek-harness' as const, tags: [],
      prompt: 'Investigate.', model: { provider: 'demo', model: 'one' }, toolIds: ['order_query'], resources: refs }
    const a = await registry.create('shared', input, randomUUID())
    const b = await registry.create('shared', { ...input, name: 'Data' }, randomUUID())
    const save = (id: string) => versions.create('shared', id, 1, randomUUID(), '', async () => {}, draft => resources.resolve(draft.resources!, true))
    const [va, vb] = await Promise.all([save(a.id), save(b.id)])
    expect(va.schemaVersion).toBe(2)
    expect(va.snapshot.resources).toEqual(vb.snapshot.resources)
    const oldHash = va.configHash
    const original = resources.get(skill.resourceId)
    await resources.update(original.id, original.revision, { name: original.name, description: '', ownerTeamId: 'team', spec: { kind: 'skill', content: 'Changed instructions' } })
    await resources.publish(original.id, 3, randomUUID())
    expect(renderVersion(va)).toContain('Ask for evidence')
    expect(renderVersion(vb)).not.toContain('Changed instructions')
    expect(snapshotHash(versions.get('shared', a.id, va.id).snapshot)).toBe(oldHash)
  })
})
