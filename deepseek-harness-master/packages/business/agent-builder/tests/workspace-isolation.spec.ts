import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { AgentRegistry } from '../src/registry.ts'
import { AgentVersions } from '../src/versions.ts'
import { AgentDeployments } from '../src/deployments.ts'
import { SharedResources } from '../src/shared-resources.ts'
import { withPrincipal } from '../src/principal-context.ts'
import type { RegistryWorkspace } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('keeps legacy identities and version hashes while enabling explicit multi-workspace ownership', async () => {
  const path = await mkdtemp(join(tmpdir(), 'workspace-migration-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(path)
  ctx.storage.backend.register('json', backend)
  cleanups.push(async () => { await backend.close(); await ctx.fiber.dispose() })
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const workspace: RegistryWorkspace = { id: 'shared', name: 'Legacy', ownerTeamId: 'team', ownerTeamName: 'Team', accessMode: 'shared-host' }
  const legacy = await AgentRegistry.open(facility, workspace)
  const versions = await AgentVersions.open(facility, legacy)
  const deployments = await AgentDeployments.open(facility, legacy, versions)
  const input = { name: 'Legacy Agent', description: '', prompt: 'Keep this prompt.', model: { provider: 'test', model: 'one' },
    toolIds: [], ownerTeamId: 'team', harnessId: 'deepseek-harness' as const, tags: [] }
  const agent = await legacy.create('shared', input, randomUUID())
  const version = await versions.create('shared', agent.id, 1, randomUUID(), '', async () => {})
  const deployment = await deployments.activate('shared', agent.id, version.id, 0, randomUUID(), 'deploy', async () => {})
  await deployments.close(); await versions.close(); await legacy.close()
  const lookup = (id: string): RegistryWorkspace => {
    if (!['shared', 'finance'].includes(id)) throw new Error('Unknown workspace')
    return { ...workspace, id, ownerTeamId: id, accessMode: 'governed' }
  }
  const registry = await AgentRegistry.open(facility, workspace, lookup)
  const reopened = await AgentVersions.open(facility, registry)
  const activations = await AgentDeployments.open(facility, registry, reopened)
  const resources = await SharedResources.open(facility, 'shared')
  cleanups.push(async () => { await resources.close(); await activations.close(); await reopened.close(); await registry.close() })
  registry.validateOwnership(); reopened.validateOwnership(); activations.validateOwnership()
  expect(registry.get('shared', agent.id)).toEqual(agent)
  expect(reopened.get('shared', agent.id, version.id)).toEqual(version)
  expect(activations.get('shared', agent.id)).toEqual(deployment)
  expect(() => registry.get('finance', agent.id)).toThrow()
  const token = randomUUID()
  const [sales, finance] = await Promise.all([
    withPrincipal({ userId: 'sales-user', workspaceId: 'shared' }, () => resources.create({ name: 'Guidance', description: '',
      ownerTeamId: 'shared', spec: { kind: 'skill', content: 'Sales only' } }, token)),
    withPrincipal({ userId: 'finance-user', workspaceId: 'finance' }, () => resources.forWorkspace('finance').create({ name: 'Guidance',
      description: '', ownerTeamId: 'finance', spec: { kind: 'skill', content: 'Finance only' } }, token)),
  ])
  expect(sales.id).not.toBe(finance.id)
  expect(resources.list().map(row => row.id)).toEqual([sales.id])
  expect(resources.forWorkspace('finance').list().map(row => row.id)).toEqual([finance.id])
  expect(() => resources.get(finance.id)).toThrow()
  expect(() =>{  resources.validateOwnership(lookup) }).not.toThrow()
  expect(() =>{  resources.validateOwnership((id) => { if (id !== 'shared') throw new Error('Unknown workspace') }) }).toThrow()
})
