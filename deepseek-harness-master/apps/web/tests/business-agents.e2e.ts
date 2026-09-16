import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

describe('business Agent selection through the Web and Session API', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/business-agents/package.json', import.meta.url))],
      agentPresets: {
        default: 'customer-service', includeShippedRoot: false,
        roots: [{ path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' }],
      },
      toolsMode: 'native',
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows exactly three business Agents and creates distinct configured Sessions', async () => {
    const roster = await scaffold.ctx.agentPresets.remoteExportList()
    expect(roster.presets.map(preset => preset.id).sort()).toEqual(['customer-service', 'data', 'operations'])
    const created: { agentPreset: string; sessionId: string }[] = []
    page.on('response', (response) => {
      if (!response.url().endsWith('/api/session/create')) return
      void response.json().then((body: { result: { value?: { sessionId: string } } }) => {
        const request = response.request().postDataJSON() as { payload: { args: { request: { agentPreset: string } } } }
        if (body.result.value) created.push({
          agentPreset: request.payload.args.request.agentPreset, sessionId: body.result.value.sessionId,
        })
      })
    })
    let current = 'Customer Service Agent'
    const choices = [['data', 'Data Agent'], ['operations', 'Operations Agent'], ['customer-service', 'Customer Service Agent']] as const
    for (const [id, label] of choices) {
      await page.getByRole('button', { name: current, exact: true }).click()
      expect(await page.getByRole('menuitem').count()).toBe(3)
      await page.getByRole('menuitem', { name: new RegExp(label) }).click()
      await page.getByRole('button', { name: label, exact: true }).waitFor()
      await expect.poll(() => created.some(item => item.agentPreset === id)).toBe(true)
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 15_000 })
      current = label
    }
    expect(new Set(created.map(item => item.sessionId)).size).toBe(3)
    await page.getByRole('button', { name: current, exact: true }).click()
    await page.screenshot({ path: '../docs/verification/business-agents-browser.png', fullPage: true })
  })
})
