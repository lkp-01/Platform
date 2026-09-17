import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RegistryAgent, AgentVersion, PlatformRun, SharedResource, ObservationReport, ObservationRunPage } from '@deepseek-ai/dsh-agent-builder'
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
    yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 15 } }
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
  root = await mkdtemp(join(tmpdir(), 'agent-observability-'))
  const config = join(root, 'governance.json')
  await writeFile(config, JSON.stringify({ users: Object.entries(tokens).map(([id, token]) => ({ id, displayName: id,
    tokenHash: createHash('sha256').update(token).digest('hex') })), workspaces: [
    { id: 'shared', name: 'Sales', adminId: 'admin' }, { id: 'finance', name: 'Finance', adminId: 'finance' },
    { id: 'ops', name: 'Operations', adminId: 'ops' },
  ], sessionHours: 8 }))
  const prices = join(root, 'prices.json')
  await writeFile(prices, JSON.stringify([{ id: 'demo-price', provider: 'workspace-test', model: 'demo', currency: 'USD',
    effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null, input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000 }]))
  const overlay = join(root, 'governance.patch.yml')
  const business = fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url))
  await writeFile(overlay, await readFile(business, 'utf8') + '\n- id: agent-builder\n  inject: [businessAgentPaths]\n  config:\n    root: !!js businessAgentPaths.managedRoot\n    governanceFile: ' + JSON.stringify(config) + '\n    observabilityPricesFile: ' + JSON.stringify(prices) + '\n    observabilityRefreshMs: 20\n    runtime:\n      pollMs: 20\n')
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

it('analyzes versions and estimated costs, enforces roles and drills into the original Trace', async () => {
  await call('admin', 'shared', 'seedResources')
  const resources = await call<SharedResource[]>('developer', 'shared', 'resources')
  const selected = resources.find(row => row.spec.kind === 'model' && row.spec.provider === 'workspace-test')!
  const input = { name: 'SRE analytics', description: 'Observable agent', ownerTeamId: 'shared', harnessId: 'deepseek-harness',
    prompt: 'Respond briefly.', model: { provider: 'workspace-test', model: 'demo' }, toolIds: [], tags: [],
    resources: { model: { resourceId: selected.id, versionId: selected.versions[0]!.id }, tools: [], skills: [] } }
  const agent = await call<RegistryAgent>('developer', 'shared', 'createAgent', [input, randomUUID()])
  const v1 = await call<AgentVersion>('developer', 'shared', 'saveVersion', [agent.id, 1, randomUUID(), 'Baseline'])
  await call('developer', 'shared', 'deploy', [agent.id, v1.id, 0, randomUUID(), 'deploy'])
  const first = await call<PlatformRun>('developer', 'shared', 'start', [agent.id, 'First', randomUUID()])
  await expect.poll(async () => (await call<PlatformRun>('developer', 'shared', 'run', [agent.id, first.id])).status).toBe('SUCCEEDED')
  const updated = await call<RegistryAgent>('developer', 'shared', 'updateAgent', [agent.id, 1, { ...input, prompt: 'New instruction.' }])
  const v2 = await call<AgentVersion>('developer', 'shared', 'saveVersion', [agent.id, updated.revision, randomUUID(), 'Candidate'])
  await call('developer', 'shared', 'deploy', [agent.id, v2.id, 1, randomUUID(), 'deploy'])
  const second = await call<PlatformRun>('developer', 'shared', 'start', [agent.id, 'Second', randomUUID()])
  await expect.poll(async () => (await call<PlatformRun>('developer', 'shared', 'run', [agent.id, second.id])).status).toBe('SUCCEEDED')
  const query = { window: { kind: 'last', count: 1000 }, agentId: agent.id }
  await expect.poll(async () => (await call<ObservationReport>('developer', 'shared', 'observability', [query])).summary.succeeded).toBe(2)
  const report = await call<ObservationReport>('developer', 'shared', 'observability', [query])
  expect(report.summary).toMatchObject({ sampleCount: 2, successRate: 1, tokens: { average: 15, validCount: 2 },
    costs: [{ currency: 'USD', nanoUnits: '30000', pricedCalls: 2 }], unpricedCalls: 0 })
  const compared = await call<ObservationReport>('developer', 'shared', 'observability', [{ ...query, versionId: v1.id, compareVersionId: v2.id }])
  expect(compared.summary.sampleCount).toBe(1)
  expect(compared.comparison).toMatchObject({ lowSample: true, summary: { sampleCount: 1 } })
  const pageData = await call<ObservationRunPage>('developer', 'shared', 'observabilityRuns', [query])
  expect(new Set(pageData.items.map(row => row.runId))).toEqual(new Set([first.id, second.id]))
  expect((await request('user', 'shared', 'observability', [query])).status).toBe(403)
  expect((await request('developer', 'shared', 'observability', [{ window: query.window }])).status).toBe(403)
  expect((await request('finance', 'finance', 'observability', [query])).status).toBe(404)
  expect((await call<ObservationReport>('finance', 'finance', 'observability', [{ window: query.window }])).summary.sampleCount).toBe(0)
  await page.goto(scaffold.baseUrl + '/platform')
  await page.getByLabel('个人访问凭证').fill(tokens.admin!)
  await page.getByRole('button', { name: '登录工作区', exact: true }).click()
  await page.getByRole('button', { name: '工作区运行总览', exact: true }).click()
  await page.getByRole('heading', { name: '依赖健康', exact: true }).waitFor()
  expect(await page.locator('main').innerText()).toContain('100.0%')
  expect(await page.locator('main').innerText()).toContain('0.000030')
  const destination = fileURLToPath(new URL('../../../../docs/verification/', import.meta.url))
  await mkdir(destination, { recursive: true })
  await page.screenshot({ path: join(destination, 'observability-workspace.png'), fullPage: true })
  expect(await page.locator('main > h2, main > h3').allTextContents()).toMatchSnapshot('observability sections')
  await page.getByRole('button', { name: '查看匹配运行', exact: true }).first().click()
  await page.getByRole('button', { name: '执行详情', exact: true }).first().click()
  await page.getByRole('heading', { name: '最终结果', exact: true }).waitFor()
  await page.getByRole('button', { name: '执行详情', exact: true }).click()
  await expect.poll(async () => page.locator('main').innerText()).toContain('model.call.completed')
  expect(errors).toEqual([])
  cookies.set('admin', (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; '))
  await call('admin', 'shared', 'member', ['developer', null, 1])
  expect((await request('developer', 'shared', 'observability', [query])).status).toBe(404)
}, 120000)
