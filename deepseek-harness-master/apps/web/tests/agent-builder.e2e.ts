import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionCreateValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-agent-builder'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from './support.ts'

describe('self-service Agent creation through the shipped Web composition', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let root: string

  async function launch() {
    const home = join(root, 'home')
    scaffold = await launchWebScaffold({
      harnessHome: home,
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
      toolsMode: 'native',
      agentPresets: {
        default: 'customer-service', includeShippedRoot: false,
        roots: [
          { path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' },
          { path: join(home, 'business-agents'), trust: 'system' },
        ],
      },
    })
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-builder-web-'))
    await launch()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    if (page !== undefined) {
      await page.screenshot({ path: '../docs/verification/agent-builder-last.png', fullPage: true })
      await writeFile('../docs/verification/agent-builder-last.txt', await page.locator('body').innerText())
    }
    await browser?.close(); await scaffold?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('creates a fourth Agent, preserves its text and model, and starts it after refresh', async () => {
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    expect((await scaffold.ctx.agentBuilder.catalog()).agents.map(agent => agent.name)).toContain('Customer Service Agent')
    await page.getByRole('button', { name: 'Agent library', exact: true }).first().click()
    const library = page.getByRole('dialog', { name: 'Agent library', exact: true })
    await library.getByText('Customer Service Agent', { exact: true }).waitFor()
    expect(await library.locator('article').count()).toBe(3)
    await library.getByRole('button', { name: 'Create Agent', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Create Agent', exact: true })
    await form.getByLabel('Name', { exact: true }).fill('Order specialist')
    await form.getByLabel('Prompt', { exact: true }).fill('Answer order questions. Preserve literal {{customer}}.\nUse selected tools only.')
    await form.getByLabel('Model', { exact: true }).selectOption({ index: process.env.DSH_BUILDER_LIVE === '1' ? 1 : 2 })
    await form.getByRole('checkbox', { name: /order_query/ }).check()
    await form.getByRole('checkbox', { name: /calendar_query/ }).check()
    await page.screenshot({ path: '../docs/verification/agent-builder-form.png', fullPage: true })
    await form.getByRole('button', { name: 'Create Agent', exact: true }).click()
    await library.getByRole('status').waitFor()
    const saved = (await scaffold.ctx.agentBuilder.catalog()).agents.find(agent => agent.name === 'Order specialist')!
    expect(saved.toolIds).toEqual(['order_query', 'calendar_query'])
    expect(saved.prompt).toContain('{{customer}}')
    expect((await scaffold.ctx.agentPresets.list()).some(preset => preset.id === saved.id)).toBe(true)
    await page.screenshot({ path: '../docs/verification/agent-builder-library.png', fullPage: true })
    await library.getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Agent library', exact: true }).first().click()
    const card = library.locator('article').filter({ has: page.getByRole('heading', { name: 'Order specialist', exact: true }) })
    await card.getByRole('button', { name: 'Use as template' }).click()
    expect(await form.getByLabel('Prompt', { exact: true }).inputValue()).toBe(saved.prompt)
    expect(await form.getByRole('checkbox', { name: /order_query/ }).isChecked()).toBe(true)
    await form.getByRole('button', { name: 'Back to agents' }).click()
    const response = page.waitForResponse(value => value.url().endsWith('/api/session/create'))
    await card.getByRole('button', { name: 'Start Chat' }).click()
    const result = await (await response).json() as { result: { value: SessionCreateValue } }
    const agent = scaffold.ctx.agents.get(result.result.value.sessionId)!
    expect(scaffold.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending).toMatchObject(saved.model)
    expect(scaffold.ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['calendar_query', 'order_query'])
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    if (process.env.DSH_BUILDER_LIVE === '1') {
      expect(process.env.DSH_SNAPSHOT).toBe('record')
      const events: SessionEvent[] = []
      scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
      const input = page.locator('[data-composer-input]').last()
      await writeComposerDraft(page, input, '请使用 order_query 查询订单 O-1002，告诉我当前订单状态。')
      const settled = scaffold.whenTurnSettled(120_000)
      await input.press('Enter')
      await settled
      const report = events.filter(event => ['tool/call', 'tool/result', 'assistant/message', 'turn/end'].includes(event.type))
      await writeFile('../docs/verification/agent-builder-live.json', JSON.stringify(report, null, 2))
      expect(events.some(event => event.type === 'tool/call' && event.data.name === 'order_query')).toBe(true)
      expect(events.filter(event => event.type === 'tool/result').every(event =>
        event.data.message.content.every(block => !block.isError))).toBe(true)
      expect(events.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0))).toBe(true)
    }
    expect(errors).toEqual([])
  }, 180_000)

  it('discovers the saved Agent after restarting the Host', async () => {
    const before = (await scaffold.ctx.agentBuilder.catalog()).agents.find(agent => agent.name === 'Order specialist')
    expect(before).toBeDefined()
    await scaffold.close()
    await launch()
    expect(await scaffold.ctx.agentBuilder.get(before!.id)).toEqual(before)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Agent library', exact: true }).first().click()
    await page.getByRole('heading', { name: 'Order specialist', exact: true }).waitFor()
  }, 120_000)
})
