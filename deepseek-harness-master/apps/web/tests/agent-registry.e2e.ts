import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-builder'
import type { RegistryAgentInput } from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

describe('Agent Registry through the shipped Web composition', () => {
  let root: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let savedId: string
  const errors: string[] = []

  async function launch() {
    scaffold = await launchWebScaffold({ harnessHome: join(root, 'home'), storageRoot: join(root, 'storage'), toolsMode: 'native',
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
      agentPresets: { default: 'customer-service', includeShippedRoot: false, roots: [
        { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
        { path: join(root, 'home', 'business-agents'), trust: 'system' },
      ] },
    })
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-registry-web-'))
    await launch()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail' && page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: '../docs/verification/agent-registry-failure.png', fullPage: true })
    }
  })

  it('creates a resource, detects concurrent edits, archives and restores without generating versions or runs', async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    const panel = page.getByRole('main', { name: 'Agents', exact: true })
    await panel.getByRole('heading', { name: 'No agents here yet' }).waitFor()
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByLabel('Name', { exact: true }).fill('Redis SRE')
    await panel.getByLabel('Description', { exact: true }).fill('Redis incident diagnosis')
    await panel.getByLabel('Prompt', { exact: true }).fill('Preserve {{literal}}\nHelp the Redis team.')
    await panel.getByLabel('Model', { exact: true }).selectOption({ index: 1 })
    await panel.getByLabel('Tags (comma separated)').fill('redis, sre')
    await panel.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).waitFor()
    savedId = page.url().split('#agents/')[1]!
    const saved = await scaffold.ctx.agentBuilder.registryGet('shared', savedId)
    expect(saved.tags).toEqual(['redis', 'sre'])
    expect(saved.prompt).toBe('Preserve {{literal}}\nHelp the Redis team.')
    expect((await scaffold.ctx.agentPresets.list()).some(preset => preset.id === savedId)).toBe(false)
    await expect(scaffold.ctx.agentBuilder.registryGet('other-workspace', savedId)).rejects.toMatchObject({ code: 'agent-registry/not-found' })
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).click()
    await panel.getByLabel('Name', { exact: true }).fill('My pending edit')
    const replacement: RegistryAgentInput = { name: 'Redis SRE updated', description: saved.description, prompt: saved.prompt,
      model: saved.model, toolIds: saved.toolIds, tags: saved.tags, ownerTeamId: saved.ownerTeamId, harnessId: saved.harnessId }
    await scaffold.ctx.agentBuilder.registryUpdate('shared', savedId, saved.revision, replacement)
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click()
    await panel.getByRole('alert').filter({ hasText: 'Agent changed' }).waitFor()
    expect(await panel.getByLabel('Name', { exact: true }).inputValue()).toBe('My pending edit')
    await panel.getByRole('button', { name: 'Reload saved draft' }).click()
    await panel.getByRole('heading', { name: 'Redis SRE updated', exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Edit draft', exact: true }).click()
    await panel.getByLabel('Description', { exact: true }).fill('Updated resource description')
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click()
    await panel.getByText('Updated resource description', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Versions', exact: true }).click()
    await panel.getByText('No saved versions yet.', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Runs', exact: true }).click()
    await panel.getByText('No platform Runs yet.', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Archive', exact: true }).click()
    await panel.getByRole('button', { name: 'Restore', exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: 'Edit draft', exact: true }).isDisabled()).toBe(true)
    expect((await scaffold.ctx.agentBuilder.registryList({ workspaceId: 'shared' })).total).toBe(0)
    await panel.getByRole('button', { name: 'Restore', exact: true }).click()
    await panel.getByRole('button', { name: 'Archive', exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Overview', exact: true }).click()
    await page.screenshot({ path: '../docs/verification/agent-registry-detail.png', fullPage: true })
    expect(errors).toEqual([])
  }, 120_000)

  it('restores deep links after Host restart and keeps legacy Presets unchanged when editing their resources', async () => {
    const catalog = await scaffold.ctx.agentBuilder.registryCatalog()
    const group = catalog.models.groups[0]!
    const legacy = await scaffold.ctx.agentBuilder.create({ name: 'Legacy', prompt: 'Original prompt',
      model: { provider: group.id, model: group.models[0]!.id }, toolIds: [] }, randomUUID())
    const registered = await scaffold.ctx.agentBuilder.registryGet('shared', legacy.id)
    const input: RegistryAgentInput = { name: registered.name, description: '', prompt: 'Edited draft', model: registered.model,
      toolIds: [], tags: [], ownerTeamId: registered.ownerTeamId, harnessId: registered.harnessId }
    await scaffold.ctx.agentBuilder.registryUpdate('shared', registered.id, registered.revision, input)
    expect((await scaffold.ctx.agentBuilder.get(legacy.id)).prompt).toBe('Original prompt')
    await scaffold.close()
    await launch()
    expect((await scaffold.ctx.agentBuilder.registryGet('shared', savedId)).description).toBe('Updated resource description')
    expect((await scaffold.ctx.agentBuilder.registryGet('shared', legacy.id)).prompt).toBe('Edited draft')
    await page.goto(`${scaffold.authenticatedUrl}#agents/${savedId}`)
    await page.getByRole('main', { name: 'Agents', exact: true }).getByRole('heading', { name: 'Redis SRE updated', exact: true }).waitFor()
    await page.getByRole('button', { name: 'All agents', exact: true }).click()
    await page.getByRole('button', { name: 'Redis SRE updated', exact: true }).waitFor()
    await page.screenshot({ path: '../docs/verification/agent-registry-list.png', fullPage: true })
    expect(errors).toEqual([])
  }, 120_000)
})
