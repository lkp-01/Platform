import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { SharedResources } from '../src/shared-resources.ts'
import { z } from 'zod'
import { resourceHash, resourceRecordSchema } from '../src/resource-schema.ts'
import { WorkspaceResourceData } from '../src/workspace-resource-data.ts'
import { discoverWorkspaceMcp, resolveMcpConfig, resolveWorkspaceCredential, type CredentialBindings } from '../src/runtime-mcp.ts'
import { prepareMcpTools } from '@deepseek-ai/dsh-mcp-client'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ResourceSpec, ResourceRef } from '../src/resource-types.ts'
async function callWorkspaceMcp(ctx: Context, resources: SharedResources, ref: ResourceRef, args: unknown,
  signal: AbortSignal, timeoutMs: number, bindings: CredentialBindings) {
  const tool = resources.binding(ref, 'tool', true)
  if (tool.spec.kind !== 'tool' || tool.spec.server === undefined || tool.spec.descriptor === undefined) throw new Error('MCP required')
  const server = tool.spec.server
  const definitions = await prepareMcpTools(ctx, [tool.spec.descriptor], () => {
    resources.binding(ref, 'tool', true)
    return resolveMcpConfig(ctx, resources, server, { timeoutMs, credentials: bindings, launchProfiles: {} })
  }, signal)
  return definitions[0]!.execute(args, { signal } as ToolRunContext)
}
const descriptor = { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-runtime-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(MemoryCredentials, { A_SECRET: 'a-first', B_SECRET: 'b-first' })
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const a = await SharedResources.open(facility, 'A')
  const data = await WorkspaceResourceData.open(facility)
  cleanups.push(async () => { await data.close(); await a.close(); await backend.close(); await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true }) })
  const publish = async (resources: SharedResources, spec: ResourceSpec): Promise<ResourceRef> => {
    const row = await resources.create({ name: spec.kind, description: '', ownerTeamId: resources.workspaceId, spec }, randomUUID())
    const version = await resources.publish(row.id, row.revision, randomUUID())
    return { resourceId: row.id, versionId: version.id }
  }
  return { ctx, a, b: a.forWorkspace('B'), data, publish }
}
it('isolates actual Memory and Dataset values with identical keys and rejects foreign parent IDs', async () => {
  const { a, b, data, publish } = await setup()
  for (const kind of ['memory-store', 'eval-dataset'] as const) {
    const ar = await publish(a, { kind, adapter: 'local' })
    const br = await publish(b, { kind, adapter: 'local' })
    await Promise.all([data.put(a, ar, kind, 'same', 'A'), data.put(b, br, kind, 'same', 'B')])
    expect(data.read(a, ar, kind, 'same')).toBe('A')
    expect(data.read(b, br, kind, 'same')).toBe('B')
    expect(() => data.read(a, br, kind, 'same')).toThrow('not found')
    await expect(data.put(a, br, kind, 'same', 'overwrite')).rejects.toThrow('not found')
    expect(data.read(b, br, kind, 'same')).toBe('B')
  }
})
it('checks every reference before opening a transport or resolving a secret and picks up secret rotation', async () => {
  const { ctx, a, b, publish } = await setup()
  const calls: string[] = []
  let discoveryDescriptor = descriptor
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } }
      if (message.id === undefined) { res.writeHead(202); res.end(); return }
      const result = message.method === 'initialize' ? { protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : message.method === 'tools/list' ? { tools: [discoveryDescriptor] } : { content: [{ type: 'text', text: req.url }] }
      if (message.method === 'tools/call') calls.push(`${req.url}:${req.headers.authorization}`)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error)
  else resolve() }); server.closeAllConnections() }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing listener')
  const bindings = { A: { redis: 'A_SECRET' }, B: { redis: 'B_SECRET' } }
  const credentials = await Promise.all([a, b].map(resources => publish(resources, { kind: 'credential', alias: 'redis' })))
  const tools = await Promise.all([a, b].map(async (resources, i) => {
    const remote = await publish(resources, { kind: 'mcp-server',
      url: `http://127.0.0.1:${address.port}/${resources.workspaceId}`, credential: credentials[i]! })
    return publish(resources, { kind: 'tool', operation: 'read', server: remote, descriptor })
  }))
  const resolveSpy = vi.spyOn(ctx.credentials, 'resolve')
  await expect(resolveWorkspaceCredential(ctx, a, credentials[1]!, bindings)).rejects.toThrow('not found')
  await expect(callWorkspaceMcp(ctx, a, tools[1]!, {}, new AbortController().signal, 1000, bindings)).rejects.toThrow('not found')
  expect(resolveSpy).not.toHaveBeenCalled(); expect(calls).toHaveLength(0)
  // Import corruption bypasses public configuration validation; dispatch still checks every reference.
  type DurableResource = z.infer<typeof resourceRecordSchema>
  const storage = a as unknown as { domain: { table(name: 'resources'): {
    get(id: string): DurableResource | undefined
    put(id: string, value: DurableResource): Promise<void>
  } } }
  const table = storage.domain.table('resources')
  const saved = table.get(tools[0]!.resourceId)!
  const foreignTool = b.get(tools[1]!.resourceId).versions[0]!
  const foreignSpec = foreignTool.spec
  await table.put(saved.id, { ...saved, versions: saved.versions.map(version => ({ ...version, spec: foreignSpec,
    specHash: resourceHash(foreignSpec) })) })
  await expect(callWorkspaceMcp(ctx, a, tools[0]!, {}, new AbortController().signal, 1000, bindings)).rejects.toThrow('not found')
  expect(resolveSpy).not.toHaveBeenCalled(); expect(calls).toHaveLength(0)
  await table.put(saved.id, saved)
  const invoke = (resources: SharedResources, ref: ResourceRef) => callWorkspaceMcp(ctx, resources, ref, {},
    new AbortController().signal, 5000, bindings)
  await invoke(a, tools[0]!); await invoke(b, tools[1]!)
  await ctx.credentials.set(credentialRef('A_SECRET'), 'a-rotated')
  await invoke(a, tools[0]!)
  expect(calls).toEqual(['/A:Bearer a-first', '/B:Bearer b-first', '/A:Bearer a-rotated'])
  discoveryDescriptor = { ...descriptor, description: 'Leaked a-rotated credential' }
  const toolSpec = a.binding(tools[0]!, 'tool', true).spec
  if (toolSpec.kind !== 'tool' || toolSpec.server === undefined) throw new Error('Missing server')
  await expect(discoverWorkspaceMcp(ctx, a, toolSpec.server,
    { timeoutMs: 5000, credentials: bindings, launchProfiles: {} }, new AbortController().signal))
    .rejects.toThrow('MCP discovery failed')
  expect(calls).toHaveLength(3)
  const row = a.get(credentials[0]!.resourceId)
  await a.setStatus(row.id, row.revision, 'disabled')
  await expect(invoke(a, tools[0]!)).rejects.toThrow('disabled')
  expect(calls).toHaveLength(3)
})
