import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RegistryAgent, AgentVersion, PlatformRun, SharedResource } from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

class WorkspaceModel extends LlmAdapter {
  calls: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return [{ provider, id: 'demo', name: 'demo' }] }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
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
const tokens = Object.fromEntries(['admin', 'developer', 'user', 'finance', 'ops'].map(id => [id, randomBytes(32).toString('base64url')]))
const cookies = new Map<string, string>()
const errors: string[] = []

async function request(actor: string, workspaceId: string, operation: string, args: unknown[] = []) {
  const response = await fetch(scaffold.baseUrl + '/platform/api', { method: 'POST', headers: {
    origin: scaffold.baseUrl, 'content-type': 'application/json', cookie: cookies.get(actor) ?? '',
  }, body: JSON.stringify({ workspaceId, operation, args }) })
  return { status: response.status, value: await response.json() as unknown }
}
async function call<T>(actor: string, workspace: string, operation: string, args: unknown[] = []): Promise<T> {
  const result = await request(actor, workspace, operation, args)
  expect(result.status, JSON.stringify(result.value)).toBe(200)
  return result.value as T
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'workspace-governance-'))
  const config = join(root, 'governance.json')
  await writeFile(config, JSON.stringify({ users: Object.entries(tokens).map(([id, token]) => ({ id, displayName: id,
    tokenHash: createHash('sha256').update(token).digest('hex') })), workspaces: [
    { id: 'shared', name: 'Sales', adminId: 'admin' }, { id: 'finance', name: 'Finance', adminId: 'finance' },
    { id: 'ops', name: 'Operations', adminId: 'ops' },
  ], sessionHours: 8 }))
  const overlay = join(root, 'governance.patch.yml')
  const business = fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url))
  await writeFile(overlay, await readFile(business, 'utf8') + '\n- id: agent-builder\n  inject: [businessAgentPaths]\n  config:\n    root: !!js businessAgentPaths.managedRoot\n    governanceFile: ' + JSON.stringify(config) + '\n    runtime:\n      pollMs: 20\n')
  scaffold = await launchWebScaffold({ governedPortal: true, harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'),
    persistenceRoot: join(root, 'sessions'), toolsMode: 'native', extraOverlayPath: overlay,
    extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
    agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
      { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
      { path: join(root, 'home', 'business-agents'), trust: 'system' },
    ] },
  })
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['workspace-test'], model), 'workspace-test.model')
  for (const [actor, token] of Object.entries(tokens)) {
    const response = await fetch(scaffold.baseUrl + '/platform/login', { method: 'POST', headers: {
      origin: scaffold.baseUrl, 'content-type': 'application/json',
    }, body: JSON.stringify({ token }) })
    expect(response.status).toBe(200)
    cookies.set(actor, response.headers.get('set-cookie')!.split(';')[0]!)
  }
  await call('admin', 'shared', 'member', ['developer', 'developer', 0])
  await call('admin', 'shared', 'member', ['user', 'user', 0])
  browser = await chromium.launch()
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
}, 120000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('closes raw Host, Session, file and WebSocket paths and rejects forged identities', async () => {
  for (const path of ['/', '/api', '/api/agentBuilder/registryList', '/api/sessionController/list', '/api/files', '/api/remote-stream']) {
    expect((await fetch(scaffold.baseUrl + path, { headers: { cookie: cookies.get('admin')! } })).status).toBe(404)
  }
  expect((await request('missing', 'shared', 'agents', [{}])).status).toBe(401)
  expect((await request('user', 'finance', 'agents', [{}])).status).toBe(404)
  expect((await request('user', 'shared', 'createResource', [])).status).toBe(403)
  const forged = await fetch(scaffold.baseUrl + '/platform/api', { method: 'POST', headers: {
    origin: scaffold.baseUrl, 'content-type': 'application/json', cookie: cookies.get('user')!, 'x-user-id': 'admin',
  }, body: JSON.stringify({ workspaceId: 'shared', operation: 'members', args: [], role: 'admin' }) })
  expect(forged.status).toBe(400)
  expect((await fetch(scaffold.baseUrl + '/platform/api', { method: 'POST', headers: {
    origin: 'https://foreign.example', 'content-type': 'application/json', cookie: cookies.get('admin')!,
  }, body: '{}' })).status).toBe(403)
})

it('collaborates within a workspace, isolates references and exposes only the caller’s run results', async () => {
  await call('admin', 'shared', 'seedResources')
  await call('finance', 'finance', 'seedResources')
  const resources = await call<SharedResource[]>('developer', 'shared', 'resources')
  const foreign = await call<SharedResource[]>('finance', 'finance', 'resources')
  expect(resources.every(row => row.workspaceId === 'shared')).toBe(true)
  expect(foreign.every(row => row.workspaceId === 'finance')).toBe(true)
  const selected = resources.find(row => row.spec.kind === 'model' && row.spec.provider === 'workspace-test')!
  const input = { name: 'Sales assistant', description: 'Sales workspace only', ownerTeamId: 'shared', harnessId: 'deepseek-harness',
    prompt: 'Respond briefly.', model: { provider: 'workspace-test', model: 'demo' }, toolIds: [], tags: [],
    resources: { model: { resourceId: selected.id, versionId: selected.versions[0]!.id }, tools: [], skills: [] } }
  const token = randomUUID()
  const agent = await call<RegistryAgent>('developer', 'shared', 'createAgent', [input, token])
  expect(agent.createdBy).toBe('developer')
  expect(await call('developer', 'shared', 'createAgent', [input, token])).toEqual(agent)
  const second = await call<RegistryAgent>('admin', 'shared', 'createAgent', [{ ...input, name: 'Second agent' }, token])
  expect(second.id).not.toBe(agent.id)
  expect((await request('finance', 'finance', 'agent', [agent.id])).status).toBe(404)
  const wrongModel = foreign.find(row => row.spec.kind === 'model')!
  expect((await request('developer', 'shared', 'createAgent', [{ ...input, resources: { ...input.resources,
    model: { resourceId: wrongModel.id, versionId: wrongModel.versions[0]!.id } } }, randomUUID()])).status).toBe(404)
  const updated = await call<RegistryAgent>('admin', 'shared', 'updateAgent', [agent.id, agent.revision, { ...input, description: 'Edited by admin' }])
  expect(updated.updatedBy).toBe('admin')
  expect((await request('developer', 'shared', 'updateAgent', [agent.id, agent.revision, input])).status).toBe(409)
  const version = await call<AgentVersion>('developer', 'shared', 'saveVersion', [agent.id, updated.revision, randomUUID(), 'Initial'])
  await call('developer', 'shared', 'deploy', [agent.id, version.id, 0, randomUUID(), 'deploy'])
  expect((await call<{ items: { id: string }[] }>('user', 'shared', 'agents', [{}])).items.map(row => row.id)).toEqual([agent.id])
  expect((await request('user', 'shared', 'agent', [agent.id])).status).toBe(403)
  const run = await call<PlatformRun>('user', 'shared', 'start', [agent.id, 'Please answer', randomUUID()])
  expect(run.createdBy).toBe('user')
  await expect.poll(async () => (await call<PlatformRun>('user', 'shared', 'run', [agent.id, run.id])).status).toBe('SUCCEEDED')
  const result = await call<PlatformRun>('user', 'shared', 'run', [agent.id, run.id])
  expect(result.result?.textPreview).toContain('Workspace result')
  expect(result.events).toEqual([])
  expect(result.runtime).toBeUndefined()
  expect((await request('user', 'shared', 'trace', [agent.id, run.id])).status).toBe(403)
  expect(model.calls[0]!.tools ?? []).toEqual([])
  const other = await call<PlatformRun>('developer', 'shared', 'start', [agent.id, 'Another user', randomUUID()])
  expect((await request('user', 'shared', 'run', [agent.id, other.id])).status).toBe(404)
  expect((await request('user', 'shared', 'cancel', [agent.id, other.id])).status).toBe(404)
  expect((await call<{ items: PlatformRun[] }>('user', 'shared', 'runs', [agent.id, 0])).items.map(row => row.id)).toEqual([run.id])
  await expect.poll(async () => (await call<PlatformRun>('developer', 'shared', 'run', [agent.id, other.id])).status).toBe('SUCCEEDED')
  await call('admin', 'shared', 'resourceStatus', [selected.id, selected.revision, 'disabled'])
  const denied = await call<PlatformRun>('user', 'shared', 'start', [agent.id, 'Disabled dependency', randomUUID()])
  await expect.poll(async () => (await call<PlatformRun>('user', 'shared', 'run', [agent.id, denied.id])).status).toBe('FAILED')
  expect(model.calls).toHaveLength(2)
})

it('renders distinct administrator and user journeys without exposing another workspace', async () => {
  await call('finance', 'finance', 'member', ['admin', 'developer', 0])
  const resources = await call<SharedResource[]>('admin', 'shared', 'resources')
  const selected = resources.find(row => row.spec.kind === 'model' && row.spec.provider === 'workspace-test')!
  await call('admin', 'shared', 'resourceStatus', [selected.id, selected.revision, 'active'])
  await page.goto(scaffold.baseUrl + '/platform')
  await page.getByLabel('个人访问凭证').fill(tokens.user!)
  await page.getByRole('button', { name: '登录工作区', exact: true }).click()
  await page.getByRole('heading', { name: 'Sales assistant', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '成员与治理' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: '创建 Agent', exact: true }).count()).toBe(0)
  expect(await page.getByRole('option').allTextContents()).toEqual(['Sales · 普通用户'])
  expect(await page.locator('nav').innerText()).toMatchSnapshot()
  await page.getByRole('button', { name: '退出', exact: true }).click()
  await page.getByLabel('个人访问凭证').fill(tokens.admin!)
  await page.getByRole('button', { name: '登录工作区', exact: true }).click()
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('Browser-created Agent')
  await page.getByLabel('指令', { exact: true }).fill('Answer the user.')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('heading', { name: 'Browser-created Agent', exact: true }).waitFor()
  await page.getByLabel('团队工作区').selectOption('finance')
  await page.getByText('暂无内容', { exact: true }).waitFor()
  expect(await page.getByRole('heading', { name: 'Sales assistant', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: '成员与治理' }).count()).toBe(0)
  await page.getByLabel('团队工作区').selectOption('shared')
  await page.getByRole('button', { name: '成员与治理' }).click()
  await page.getByLabel('用户 ID').waitFor()
  expect(await page.locator('nav').innerText()).toMatchSnapshot()
  await mkdir('../docs/verification', { recursive: true })
  await page.screenshot({ path: '../docs/verification/workspace-governance-members.png', fullPage: true })
  expect(errors).toEqual([])
})
