import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from './support.ts'

// Explicit opt-in: ordinary keyless browser runs never spend provider tokens.
describe.skipIf(process.env.DSH_BUSINESS_LIVE !== '1')('business Agents with the real DeepSeek provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const events: SessionEvent[] = []
  const output = fileURLToPath(new URL('../../../../docs/verification/', import.meta.url))

  beforeAll(async () => {
    if (process.env.DSH_SNAPSHOT !== 'record') throw new Error('Live acceptance requires DSH_SNAPSHOT=record')
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../../../packages/bundle/business-agents/cordis.patch.yml', import.meta.url)),
      agentPresets: {
        default: 'customer-service', includeShippedRoot: false,
        roots: [{ path: fileURLToPath(new URL('../../../packages/bundle/business-agents/presets/', import.meta.url)), trust: 'system' }],
      },
      toolsMode: 'native',
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  const cases = [
    {
      id: 'customer', name: 'Customer Service Agent',
      prompt: '我的订单 O-1002 一直没发货，请查询订单和发货延期政策，引用知识来源，并为我创建升级工单。可以直接执行模拟操作。',
      tools: ['knowledge_search', 'order_query', 'ticket_create'],
    },
    {
      id: 'data', name: 'Data Agent',
      prompt: '请先查看数据字典，用数据库查询分析 2026 年 8 月相比 7 月哪个产品收入下降最多，再使用数值分析工具计算它的收入变化比例。另查询两个月整体退款率并解释上涨的可能原因，区分数据事实与因果推测。',
      tools: ['data_catalog', 'sql_query', 'data_analyze'],
    },
    {
      id: 'operations', name: 'Operations Agent',
      prompt: '请整理演示日期当天延期的项目，查看负责人的 2026-09-16 日历，为延期项目创建明天到期的跟进任务，再给负责人发送引用这个任务的模拟通知，最后总结结果。直接执行这些模拟操作。',
      tools: ['project_query', 'calendar_query', 'task_create', 'message_send'],
    },
  ]

  for (const scenario of cases) {
    it(scenario.name, async () => {
      if (scenario.id !== 'customer') await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      await page.getByRole('button', { name: /^(Customer Service Agent|Data Agent|Operations Agent)$/ }).click()
      await page.getByRole('menuitem', { name: new RegExp(scenario.name) }).click()
      const input = page.locator('[data-composer-input]').last()
      await writeComposerDraft(page, input, scenario.prompt)
      events.length = 0
      const settled = scaffold.whenTurnSettled(180_000)
      await input.press('Enter')
      const sessionId = await settled
      const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
      const report = events.filter(event => ['tool/call', 'tool/result', 'assistant/message', 'turn/end'].includes(event.type))
      await writeFile(`${output}${scenario.id}-live.json`, JSON.stringify({ sessionId, calls, events: report }, null, 2))
      await page.screenshot({ path: `${output}${scenario.id}-live.png`, fullPage: true })
      expect(calls).toEqual(expect.arrayContaining(scenario.tools))
      const results = events.filter(event => event.type === 'tool/result')
      expect(results.length).toBeGreaterThanOrEqual(scenario.tools.length)
      expect(results.every(event => event.data.message.content.every(block => !block.isError))).toBe(true)
      expect(events.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0))).toBe(true)
      await page.reload()
      await page.getByText(scenario.name, { exact: true }).first().waitFor({ timeout: 15_000 })
      await page.locator('[data-chat-turn]').first().waitFor({ timeout: 15_000 })
    }, 200_000)
  }
})
