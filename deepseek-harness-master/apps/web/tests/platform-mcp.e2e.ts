import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RegistryAgent, AgentVersion, PlatformRun, SharedResource, ResourceRef } from '@deepseek-ai/dsh-agent-builder'
import type { RunTracePage } from '../../../packages/business/agent-builder/src/trace-types.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

class IsolationModel extends LlmAdapter {
  calls: GenerateOptions[] = []
  seen = new Set<string>()
  forced: string | undefined
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return [{ provider, id: 'demo', name: 'demo' }] }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const names = options.tools?.map(tool => tool.name) ?? []
    const key = names.join(',')
    const target = this.forced ?? names[0]
    const forced = this.forced !== undefined
    this.forced = undefined
    if (target !== undefined && (forced || !this.seen.has(key))) {
      this.seen.add(key)
      const id = ToolCallId(randomUUID())
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: target, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: target, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Isolated result' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Isolated result' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let root: string
let scaffold: WebScaffold
let browser: Browser
let page: Page
let endpoint: string
const model = new IsolationModel()
const calls: { path: string; operation: string }[] = []
const lists: Record<string, { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, never> } }[]> = {
  '/redis': ['redis_get', 'redis_delete'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
  '/github': [{ name: 'github_read', description: 'github_read', inputSchema: { type: 'object', properties: {} } }],
  '/filesystem': [{ name: 'file_read', description: 'file_read', inputSchema: { type: 'object', properties: {} } }],
}
const remote = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number
      method: string
      params?: { protocolVersion?: string
        name?: string } }
    if (message.id === undefined) { res.writeHead(202); res.end(); return }
    const path = req.url ?? ''
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: lists[path] ?? [] }
    else { calls.push({ path, operation: message.params?.name ?? '' }); result = { content: [{ type: 'text', text: `Result from ${path}` }] } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })().catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))))
})
async function request(workspaceId: string, operation: string, args: unknown[] = []) {
  const response = await fetch(scaffold.baseUrl + '/platform/api', { method: 'POST', headers: {
    origin: scaffold.baseUrl, 'content-type': 'application/json',
  }, body: JSON.stringify({ workspaceId, operation, args }) })
  return { status: response.status, value: await response.json() as unknown }
}
async function call<T>(workspace: string, operation: string, args: unknown[] = []): Promise<T> {
  const result = await request(workspace, operation, args)
  expect(result.status, JSON.stringify(result.value)).toBe(200)
  return result.value as T
}
async function publish(workspace: string, name: string, spec: SharedResource['spec']): Promise<ResourceRef> {
  const row = await call<SharedResource>(workspace, 'createResource', [{ name, description: '', ownerTeamId: workspace, spec }, randomUUID()])
  const version = await call<{ id: ResourceRef['versionId'] }>(workspace, 'publishResource', [row.id, row.revision, randomUUID()])
  return { resourceId: row.id, versionId: version.id }
}
async function finish(workspace: string, agent: RegistryAgent, run: PlatformRun) {
  await expect.poll(async () => (await call<PlatformRun>(workspace, 'run', [agent.id, run.id])).status,
    { timeout: 20000 }).toMatch(/^(SUCCEEDED|FAILED|BLOCKED|CANCELLED)$/)
  return call<PlatformRun>(workspace, 'run', [agent.id, run.id])
}
beforeAll(async () => {
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const address = remote.address()
  if (address === null || typeof address === 'string') throw new Error('Missing MCP listener')
  endpoint = `http://127.0.0.1:${address.port}`
  root = await mkdtemp(join(tmpdir(), 'platform-mcp-'))
  const overlay = join(root, 'workspace.patch.yml')
  const business = fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url))
  await writeFile(overlay, await readFile(business, 'utf8') + '\n- id: agent-builder\n  inject: [businessAgentPaths]\n  config:\n    root: !!js businessAgentPaths.managedRoot\n    workspaceDemo: true\n    runtime:\n      pollMs: 20\n')
  scaffold = await launchWebScaffold({ governedPortal: true, harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'),
    persistenceRoot: join(root, 'sessions'), toolsMode: 'native', extraOverlayPath: overlay,
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
    agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
      { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
      { path: join(root, 'home', 'business-agents'), trust: 'system' },
    ] },
  })
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['isolation-test'], model), 'isolation-test.model')
  browser = await chromium.launch(); page = await browser.newPage()
}, 120000)
afterAll(async () => {
  await browser?.close(); await scaffold?.close()
  await new Promise<void>((resolve, reject) => {
    remote.close((error) => { if (error) reject(error); else resolve() })
    remote.closeAllConnections()
  })
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})
it('isolates bound schemas and dispatch on the same Host and attributes native calls to immutable resources', async () => {
  const a = await call<{ id: string }>('', 'createWorkspace', ['MCP A', randomUUID()])
  const b = await call<{ id: string }>('', 'createWorkspace', ['MCP B', randomUUID()])
  const agents: RegistryAgent[] = []
  const refs: ResourceRef[] = []
  const toolRefs: ResourceRef[] = []
  for (const [workspace, path, operation] of [[a.id, '/redis', 'redis_get'], [b.id, '/github', 'github_read']]) {
    const modelRef = await publish(workspace!, 'model', { kind: 'model', provider: 'isolation-test', model: 'demo' })
    const server = await publish(workspace!, path!, { kind: 'mcp-server', url: endpoint + path! }); refs.push(server)
    const tool = await call<SharedResource>(workspace!, 'mcpImport', [server, operation, randomUUID()])
    expect((await call<SharedResource>(workspace!, 'mcpImport', [server, operation, randomUUID()])).id).toBe(tool.id)
    const published = await call<{ id: ResourceRef['versionId'] }>(workspace!, 'publishResource', [tool.id, tool.revision, randomUUID()])
    const toolRef = { resourceId: tool.id, versionId: published.id }; toolRefs.push(toolRef)
    const agent = await call<RegistryAgent>(workspace!, 'createAgent', [{ name: operation, description: 'Isolated MCP', ownerTeamId: workspace,
      harnessId: 'deepseek-harness', prompt: 'Call your bound tool once.', model: { provider: 'isolation-test', model: 'demo' },
      toolIds: [], tags: [], resources: { model: modelRef, tools: [toolRef], skills: [] } }, randomUUID()])
    const version = await call<AgentVersion>(workspace!, 'saveVersion', [agent.id, agent.revision, randomUUID(), 'Pinned MCP'])
    await call(workspace!, 'deploy', [agent.id, version.id, 0, randomUUID(), 'deploy']); agents.push(agent)
  }
  await publish(a.id, 'filesystem', { kind: 'mcp-server', url: endpoint + '/filesystem' })
  expect((await request(a.id, 'mcpDiscover', [refs[1]])).status).toBe(404)
  const runs = await Promise.all([a, b].map((workspace, i) => call<PlatformRun>(workspace.id, 'start', [agents[i]!.id, 'Run', randomUUID()])))
  const completed = await Promise.all([a, b].map((workspace, i) => finish(workspace.id, agents[i]!, runs[i]!)))
  expect(completed.map(run => ({ status: run.status, error: run.error }))).toEqual([
    { status: 'SUCCEEDED', error: null }, { status: 'SUCCEEDED', error: null },
  ])
  expect(calls.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
    { path: '/github', operation: 'github_read' }, { path: '/redis', operation: 'redis_get' },
  ])
  for (const options of model.calls) expect(options.tools).toHaveLength(1)
  expect([...new Set(model.calls.map(options => options.tools?.[0]?.description))].sort()).toEqual(['github_read', 'redis_get'])
  expect(model.calls.map(options => options.tools?.map(({ description, parameters }) => ({ description, parameters })))
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toMatchSnapshot()
  const trace = await call<RunTracePage>(a.id, 'traceEvents', [agents[0]!.id, runs[0]!.id])
  expect(trace.trace.toolCalls).toBe(1)
  const toolEvents = trace.items.filter(item => item.tool !== null)
  expect(toolEvents.length).toBeGreaterThan(0)
  for (const item of toolEvents) {
    expect(item.toolResourceId).toBe(toolRefs[0]!.resourceId)
    expect(item.mcpServerId).toBe(refs[0]!.resourceId)
    expect(item.mcpServerVersionId).toBe(refs[0]!.versionId)
  }
  const foreignName = model.calls.find(options => options.tools?.[0]?.description === 'github_read')!.tools![0]!.name
  model.forced = foreignName
  const forged = await call<PlatformRun>(a.id, 'start', [agents[0]!.id, 'Try a foreign tool', randomUUID()])
  await finish(a.id, agents[0]!, forged)
  expect(calls).toHaveLength(2)
  lists['/redis']!.push({ name: 'delete_all', description: 'delete_all', inputSchema: { type: 'object', properties: {} } })
  model.seen.clear()
  const expanded = await call<PlatformRun>(a.id, 'start', [agents[0]!.id, 'Repeat', randomUUID()])
  expect((await finish(a.id, agents[0]!, expanded)).status).toBe('SUCCEEDED')
  expect(model.calls.at(-1)!.tools).toHaveLength(1)
  lists['/redis']![0]!.description = 'Changed schema contract'
  const incompatible = await call<PlatformRun>(a.id, 'start', [agents[0]!.id, 'Repeat', randomUUID()])
  expect((await finish(a.id, agents[0]!, incompatible)).status).toBe('FAILED')
  expect(calls).toHaveLength(3)
  await page.goto(scaffold.baseUrl + '/platform')
  await page.getByLabel('团队工作区').selectOption(a.id)
  await page.getByRole('button', { name: '共享资源', exact: true }).click()
  const redis = page.locator('.card').filter({ has: page.getByRole('heading', { name: '/redis', exact: true }) })
  await redis.getByRole('button', { name: '连接与发现工具', exact: true }).click()
  await page.getByRole('button', { name: '连接与发现工具', exact: true }).click()
  await expect.poll(() => page.locator('main').innerText()).toContain('delete_all')
  expect(await page.locator('main').innerText()).not.toContain('github_read')
}, 60000)
