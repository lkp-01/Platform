import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RegistryAgent, AgentVersion, PlatformRun, SharedResource } from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

class WorkspaceModel extends LlmAdapter {
  tool: { name: string; args: unknown } | undefined
  calls: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return [{ provider, id: 'demo', name: 'demo' }] }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.tool !== undefined) {
      const tool = this.tool; this.tool = undefined
      const id = ToolCallId(randomUUID()); const args = JSON.stringify(tool.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Workspace result' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Workspace result' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
let root: string
let scaffold: WebScaffold
let browser: Browser
let page: Page
const model = new WorkspaceModel()
const errors: string[] = []
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
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'platform-workspace-'))
  const overlay = join(root, 'workspace.patch.yml')
  const business = fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url))
  await writeFile(overlay, await readFile(business,
    'utf8') + '\n- id: agent-builder\n  inject: [businessAgentPaths]\n  config:\n    root: !!js businessAgentPaths.managedRoot\n    workspaceDemo: true\n    runtime:\n      pollMs: 20\n')
  scaffold = await launchWebScaffold({ governedPortal: true, harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'),
    persistenceRoot: join(root, 'sessions'), toolsMode: 'native', extraOverlayPath: overlay,
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
    agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
      { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
      { path: join(root, 'home', 'business-agents'), trust: 'system' },
    ] },
  })
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['workspace-test'], model), 'workspace-test.model')
  browser = await chromium.launch(); page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
}, 120000)
afterAll(async () => { await browser?.close(); await scaffold?.close(); if (root !== undefined) await rm(root,
  { recursive: true, force: true }) })
it('creates namespaces without login, isolates resources and executes bound Memory through the real Harness loop', async () => {
  const a = await call<{ id: string }>('', 'createWorkspace', ['Workspace A', randomUUID()])
  const b = await call<{ id: string }>('', 'createWorkspace', ['Workspace B', randomUUID()])
  expect((await request('', 'resources')).status).toBe(400)
  expect((await request('missing', 'resources')).status).toBe(404)
  const publish = async (workspace: string, name: string, spec: SharedResource['spec']) => {
    const row = await call<SharedResource>(workspace, 'createResource', [{ name, description: '', ownerTeamId: workspace,
      spec }, randomUUID()])
    const version = await call<{ id: string }>(workspace, 'publishResource', [row.id, row.revision, randomUUID()])
    return { resourceId: row.id, versionId: version.id }
  }
  const agents: RegistryAgent[] = []
  const memories: { resourceId: string; versionId: string }[] = []
  for (const workspace of [a.id, b.id]) {
    const selected = await publish(workspace, 'model', { kind: 'model', provider: 'workspace-test', model: 'demo' })
    const tool = await publish(workspace, 'redis-tool', { kind: 'tool', operation: 'order_query' })
    const memory = await publish(workspace, 'memory', { kind: 'memory-store', adapter: 'local' }); memories.push(memory)
    const dataset = await publish(workspace, 'evaluation', { kind: 'eval-dataset', adapter: 'local' })
    await call(workspace, 'putResourceData', [dataset, 'eval-dataset', 'same', workspace])
    const agent = await call<RegistryAgent>(workspace, 'createAgent', [{ name: 'redis-agent',
      description: workspace === a.id ? 'Only A' : 'Only B',
      ownerTeamId: workspace, harnessId: 'deepseek-harness', prompt: 'Use your bound MemoryStore when asked.',
      model: { provider: 'workspace-test', model: 'demo' }, toolIds: [], tags: [], resources: { model: selected, tools: [tool],
        skills: [], memoryStores: [memory] } }, randomUUID()])
    agents.push(agent)
  }
  const agent = agents[0]!
  expect((await request(a.id, 'agent', [agents[1]!.id])).status).toBe(404)
  expect((await request(a.id, 'readResourceData', [memories[1], 'memory-store', 'same'])).status).toBe(404)
  const update = { name: agent.name, description: agent.description, prompt: agent.prompt, model: agent.model,
    toolIds: [], tags: agent.tags, ownerTeamId: a.id, harnessId: agent.harnessId,
    resources: { ...agent.resources!, tools: agents[1]!.resources!.tools } }
  expect((await request(a.id, 'updateAgent', [agent.id, agent.revision, update])).status).toBe(404)
  expect((await call<RegistryAgent>(a.id, 'agent', [agent.id])).revision).toBe(agent.revision)
  const version = await call<AgentVersion>(a.id, 'saveVersion', [agent.id, agent.revision, randomUUID(), 'Initial'])
  await call(a.id, 'deploy', [agent.id, version.id, 0, randomUUID(), 'deploy'])
  model.tool = { name: 'platform_memory_put', args: { storeId: memories[0]!.resourceId, key: 'same', value: 'Run A wrote this' } }
  const run = await call<PlatformRun>(a.id, 'start', [agent.id, 'Save a memory', randomUUID()])
  await expect.poll(async () => (await call<PlatformRun>(a.id, 'run', [agent.id, run.id])).status,
    { timeout: 20000 }).toMatch(/^(SUCCEEDED|FAILED|BLOCKED)$/)
  const completed = await call<PlatformRun>(a.id, 'run', [agent.id, run.id])
  expect(completed.status, JSON.stringify(completed.error)).toBe('SUCCEEDED')
  expect(await call(a.id, 'readResourceData', [memories[0], 'memory-store', 'same'])).toBe('Run A wrote this')
  expect(await call(b.id, 'readResourceData', [memories[1], 'memory-store', 'same'])).toBeNull()
  const trace = await call<{ platformWorkspaceId: string; toolCalls: number }>(a.id, 'trace', [agent.id, run.id])
  expect(trace.platformWorkspaceId).toBe(a.id); expect(trace.toolCalls).toBe(1)
  expect((await request(b.id, 'trace', [agent.id, run.id])).status).toBe(404)
  model.tool = { name: 'platform_memory_put', args: { storeId: memories[1]!.resourceId, key: 'same', value: 'Forbidden' } }
  const bad = await call<PlatformRun>(a.id, 'start', [agent.id, 'Try an unbound store', randomUUID()])
  await expect.poll(async () => (await call<PlatformRun>(a.id, 'run', [agent.id, bad.id])).status,
    { timeout: 20000 }).toMatch(/^(SUCCEEDED|FAILED|BLOCKED)$/)
  expect(await call(b.id, 'readResourceData', [memories[1], 'memory-store', 'same'])).toBeNull()
  await page.goto(scaffold.baseUrl + '/platform')
  await page.getByLabel('团队工作区').selectOption(a.id)
  await expect.poll(() => page.locator('main').innerText()).toContain('Only A')
  await page.getByLabel('团队工作区').selectOption(b.id)
  await expect.poll(() => page.locator('main').innerText()).toContain('Only B')
  expect(await page.locator('main').innerText()).not.toContain('Only A')
  await page.reload()
  await expect.poll(() => page.locator('main').innerText()).toContain('Only B')
  expect((await call<PlatformRun>(a.id, 'run', [agent.id, run.id])).platformWorkspaceId).toBe(a.id)
  expect(await page.locator('main').innerText()).toMatchSnapshot()
  expect(errors).toEqual([])
}, 60000)

it('creates and restores a namespace through the Demo selector', async () => {
  await page.getByRole('button', { name: '创建工作区', exact: true }).click()
  await page.getByLabel('工作区名称', { exact: true }).fill('Workspace C')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => page.locator('main').innerText()).toContain('暂无内容')
  const id = await page.getByLabel('团队工作区').inputValue()
  await page.reload()
  await expect.poll(() => page.getByLabel('团队工作区').inputValue()).toBe(id)
  expect(await page.locator('main').innerText()).not.toContain('redis-agent')
  expect(errors).toEqual([])
})
