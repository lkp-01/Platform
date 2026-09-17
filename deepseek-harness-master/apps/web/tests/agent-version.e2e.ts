import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

class VersionModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return ['one', 'two'].map(id => ({ provider, id, name: id })) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Version test completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Version test completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Agent Version through the shipped Web composition', () => {
  let root: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let model: VersionModel
  const errors: string[] = []
  async function launch() {
    scaffold = await launchWebScaffold({ harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'),
      persistenceRoot: join(root, 'sessions'), toolsMode: 'native',
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
      agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
        { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
        { path: join(root, 'home', 'business-agents'), trust: 'system' },
      ] },
    })
    model = new VersionModel()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['version-test'], model), 'version-test.model')
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-version-web-'))
    await launch()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)
  afterAll(async () => {
    await browser?.close(); await scaffold?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('saves, deploys, executes, rolls back and reads the original Run after a Host restart', async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const panel = page.getByRole('main', { name: 'Agents', exact: true })
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByLabel('Name', { exact: true }).fill('Versioned SRE')
    await panel.getByLabel('Prompt', { exact: true }).fill('Prompt A literal {{value}}')
    await panel.getByLabel('Model', { exact: true }).selectOption({ label: 'version-test / one' })
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).waitFor()
    const agentId = page.url().split('#agents/')[1]!
    await panel.getByRole('button', { name: 'Versions', exact: true }).click()
    await panel.getByLabel('Change note (optional)').fill('Initial configuration')
    await panel.getByRole('button', { name: 'Save as new version', exact: true }).click()
    await panel.locator('[data-version="1"]').waitFor()
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).click()
    await panel.getByLabel('Prompt', { exact: true }).fill('Prompt B')
    await panel.getByLabel('Model', { exact: true }).selectOption({ label: 'version-test / two' })
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click()
    await panel.getByRole('button', { name: 'Versions', exact: true }).click()
    await panel.getByLabel('Change note (optional)').fill('Use Prompt B and model two')
    await panel.getByRole('button', { name: 'Save as new version', exact: true }).click()
    const v2Row = panel.locator('[data-version="2"]')
    await v2Row.waitFor()
    await v2Row.getByRole('button', { name: 'Deploy', exact: true }).click()
    await v2Row.getByText('Deployed', { exact: true }).waitFor()
    await page.screenshot({ path: '../docs/verification/agent-version-versions.png', fullPage: true })
    await panel.getByRole('button', { name: 'Runs', exact: true }).click()
    await panel.getByLabel('Task', { exact: true }).fill('Run with model two')
    await panel.getByRole('button', { name: 'Start Run', exact: true }).click()
    await panel.getByRole('button', { name: 'View execution', exact: true }).first().waitFor()
    const first = (await scaffold.ctx.agentBuilder.runList('shared', agentId, 0)).items[0]!
    await expect.poll(async () => (await scaffold.ctx.agentBuilder.runGet('shared', agentId, first.id)).status).toBe('SUCCEEDED')
    await panel.getByRole('button', { name: 'Versions', exact: true }).click()
    const v1Row = panel.locator('[data-version="1"]')
    await v1Row.getByRole('button', { name: 'Roll back', exact: true }).click()
    await v1Row.getByText('Deployed', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Runs', exact: true }).click()
    await panel.getByLabel('Task', { exact: true }).fill('Run with model one')
    await panel.getByRole('button', { name: 'Start Run', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.agentBuilder.runList('shared', agentId, 0)).items.length).toBe(2)
    const second = (await scaffold.ctx.agentBuilder.runList('shared', agentId, 0)).items.find(run => run.id !== first.id)!
    await expect.poll(async () => (await scaffold.ctx.agentBuilder.runGet('shared', agentId, second.id)).status).toBe('SUCCEEDED')
    expect(model.requests).toHaveLength(2)
    expect(model.requests.map(request => ({ model: request.model, tools: request.tools?.map(tool => tool.name) ?? [],
      rolePrompt: request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
        .filter(block => block.type === 'text').flatMap(block => block.text.split('\n\n')).filter(text => text.startsWith('Prompt ')),
    }))).toMatchSnapshot()
    expect(first.agentVersionId).not.toBe(second.agentVersionId)
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.locator('[data-run]').getByText('Succeeded', { exact: true }).first().waitFor()
    await page.screenshot({ path: '../docs/verification/agent-version-runs.png', fullPage: true })
    await panel.getByRole('button', { name: 'View execution', exact: true }).first().click()
    await page.getByText('This Run keeps its saved configuration. Start a new task from the Agent page to continue.', { exact: true }).waitFor()
    await page.getByText('Version test completed', { exact: true }).first().waitFor()
    const originalCwd = scaffold.workspaceCwd
    await scaffold.close()
    await launch()
    const afterRestart = await scaffold.ctx.agentBuilder.runGet('shared', agentId, first.id)
    expect(afterRestart).toMatchObject({ agentVersionId: first.agentVersionId, status: 'SUCCEEDED' })
    expect((await scaffold.ctx.agentBuilder.deploymentGet('shared', agentId))?.versionId).toBe(second.agentVersionId)
    await scaffold.ctx.sessionController.create({
      sessionId: first.sessionId, agentPreset: first.agentVersionId, cwd: originalCwd,
    })
    await page.goto(`${scaffold.authenticatedUrl}#agents/${agentId}`)
    await page.getByRole('main', { name: 'Agents', exact: true }).getByRole('heading', { name: 'Versioned SRE', exact: true }).waitFor()
    expect(errors).toEqual([])
  }, 120_000)
})
