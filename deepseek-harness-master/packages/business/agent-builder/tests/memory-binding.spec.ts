import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { agentResourcesSchema, resourceManifestSchema } from '../src/resource-schema.ts'
import { SharedResources } from '../src/shared-resources.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('pins scoped MemoryStore policy into the resolved Agent resource manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-binding-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const resources = await SharedResources.open(new DomainFacility(ctx, { backend: 'json' }), 'workspace-a')
  cleanups.push(async () => { await resources.close(); await backend.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const create = async (name: string, spec: { kind: 'model'; provider: string; model: string } | { kind: 'memory-store'; adapter: 'local' }) => {
    const row = await resources.create({ name, description: '', ownerTeamId: 'team', spec }, randomUUID())
    const version = await resources.publish(row.id, row.revision, randomUUID())
    return { resourceId: row.id, versionId: version.id }
  }
  const model = await create('model', { kind: 'model', provider: 'demo', model: 'one' })
  const memory = await create('customer-memory', { kind: 'memory-store', adapter: 'local' })
  const manifest = resources.resolve({ model, tools: [], skills: [], memoryBindings: [{ ...memory,
    readScopes: ['user', 'session'], writeScopes: ['user'], retrieval: { enabled: true, topK: 3, minScore: 0.2 },
    extraction: { sessionSummary: true, semanticFact: true } }] })

  expect(manifest.memoryBindings).toHaveLength(1)
  expect(manifest.memoryBindings![0]).toMatchObject({ resourceId: memory.resourceId, readScopes: ['user', 'session'] })
  expect(() => resourceManifestSchema.parse(manifest)).not.toThrow()
  await resources.setStatus(memory.resourceId, 2, 'disabled')
  expect(() => resources.assertAvailable(manifest)).toThrow('disabled')
})

it('rejects duplicate Memory scopes in one immutable binding', () => {
  expect(() => agentResourcesSchema.parse({ model: { resourceId: 'shared-0123456789abcdef0123456789abcdef', versionId: 'rv-0123456789abcdef0123456789abcdef' },
    tools: [], skills: [], memoryBindings: [{ resourceId: 'shared-abcdef0123456789abcdef0123456789', versionId: 'rv-abcdef0123456789abcdef0123456789',
      readScopes: ['user', 'user'], writeScopes: [], retrieval: { enabled: true, topK: 1, minScore: 0 },
      extraction: { sessionSummary: false, semanticFact: false } }] })).toThrow('unique')
})
