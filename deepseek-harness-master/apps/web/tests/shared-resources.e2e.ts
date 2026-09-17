import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

class ResourceModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return [{ provider, id: 'demo', name: 'demo' }] }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const id = ToolCallId('shared-order-call')
      const args = JSON.stringify({ orderId: 'O-1002' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'order_query', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'order_query', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Shared resources completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Shared resources completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Shared Resources in the shipped Web composition', () => {
  let root: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const model = new ResourceModel()
  const errors: string[] = []
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'resources-web-'))
    scaffold = await launchWebScaffold({ harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'),
      persistenceRoot: join(root, 'sessions'), toolsMode: 'native',
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
      agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
        { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
        { path: join(root, 'home', 'business-agents'), trust: 'system' },
      ] },
    })
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['resource-test'], model), 'resource-test.model')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close(); if (root !== undefined) await rm(root,
    { recursive: true, force: true }) })

  it('registers a Skill, selects shared versions, runs pinned content and blocks disabled resources', async () => {
    await page.getByRole('button', { name: 'Resources', exact: true }).click()
    const center = page.getByRole('main', { name: 'Resources', exact: true })
    await center.getByRole('button', { name: 'Register resource', exact: true }).click()
    await center.getByLabel('Name', { exact: true }).fill('incident-triage')
    await center.getByLabel('Skill instructions', { exact: true }).fill('Collect evidence before drawing conclusions.')
    await center.getByRole('button', { name: 'Save draft', exact: true }).click()
    await center.getByRole('button', { name: 'Publish new version', exact: true }).click()
    await center.locator('summary').filter({ hasText: /^v1/ }).waitFor()
    const builder = scaffold.ctx.agentBuilder
    const skill = (await builder.resourceList()).find(row => row.name === 'incident-triage')!
    expect(skill.versions).toHaveLength(1)
    await page.screenshot({ path: '../docs/verification/shared-resources-center.png', fullPage: true })

    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const panel = page.getByRole('main', { name: 'Agents', exact: true })
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByLabel('Name', { exact: true }).fill('Shared SRE')
    await panel.getByLabel('Prompt', { exact: true }).fill('Investigate the incident.')
    await panel.getByLabel('Model', { exact: true }).selectOption({ label: 'resource-test / demo' })
    await panel.getByRole('checkbox', { name: /incident-triage/ }).check()
    await panel.getByRole('checkbox', { name: /order_query/ }).check()
    await page.screenshot({ path: '../docs/verification/shared-resources-agent.png', fullPage: true })
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).waitFor()
    const id = page.url().split('#agents/')[1]!
    const agent = await builder.registryGet('shared', id)
    expect(agent.resources?.skills[0]?.versionId).toBe(skill.versions[0]!.id)
    const version = await builder.versionCreate('shared', id, agent.revision, randomUUID(), 'Shared resources')
    await builder.deploymentActivate('shared', id, version.id, 0, randomUUID(), 'deploy')
    const duplicate = await builder.registryCreate('shared', { name: 'Shared Data', description: '', ownerTeamId: agent.ownerTeamId,
      harnessId: agent.harnessId, tags: [], prompt: agent.prompt, model: agent.model, toolIds: agent.toolIds,
      resources: agent.resources }, randomUUID())
    expect((await builder.resourceUsage(skill.id)).map(use => use.agentId)).toContain(duplicate.id)
    const edited = await builder.resourceUpdate(skill.id, skill.revision, { name: skill.name, description: '',
      ownerTeamId: skill.ownerTeamId,
      spec: { kind: 'skill', content: 'New instructions must not replace v1.' } })
    await builder.resourcePublish(skill.id, edited.revision, randomUUID())
    const run = await builder.runStart('shared', id, 'Check shared behavior', randomUUID())
    await expect.poll(async () => (await builder.runGet('shared', id, run.id)).status, { timeout: 10000 }).toBe('SUCCEEDED')
    const request = model.requests[0]!
    const text = request.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('Collect evidence before drawing conclusions.')
    expect(text).not.toContain('New instructions must not replace v1.')
    expect({ tools: request.tools?.map(tool => tool.name),
      bindings: version.snapshot.resources?.skills.map(item => ({ name: item.name, version: item.versionNumber, spec: item.spec })),
    }).toMatchSnapshot()
    const current = (await builder.resourceList()).find(row => row.id === skill.id)!
    await builder.resourceStatus(skill.id, current.revision, 'disabled')
    const failed = await builder.runStart('shared', id, 'Must not call model', randomUUID())
    await expect.poll(async () => (await builder.runGet('shared', id, failed.id)).status, { timeout: 10000 }).toBe('FAILED')
    expect(model.requests).toHaveLength(2)
    await expect.poll(async () => (await builder.runTraceGet('shared', id, run.id)).toolCalls).toBe(1)
    expect((await builder.versionGet('shared', id, version.id)).snapshot.resources?.skills[0]?.versionNumber).toBe(1)
    expect(errors).toEqual([])
  }, 120_000)
})
