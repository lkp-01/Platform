import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-builder'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

class VersionModel extends LlmAdapter {
  hold: Promise<void> | null = null
  fail = false
  entered = Promise.withResolvers<undefined>()
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return ['one', 'two'].map(id => ({ provider, id, name: id })) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve(undefined)
    if (this.hold !== null) await this.hold
    if (this.fail) throw new Error('Model execution failed')
    if (!options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
      const id = ToolCallId(randomUUID())
      const args = JSON.stringify({ overdueOnly: true })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'project_query', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'project_query', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Version test completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Version test completed' } }
    yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Run lifecycle through the shipped Web composition', () => {
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
    root = await mkdtemp(join(tmpdir(), 'agent-run-web-'))
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

  it('shows final results, direct links, failure and confirmed cancellation', async () => {
    const builder = scaffold.ctx.agentBuilder
    const resource = await builder.registryCreate('shared', { name: 'Run SRE', prompt: 'Investigate alerts', description: '', tags: [],
      model: { provider: 'version-test', model: 'one' }, toolIds: ['project_query'], ownerTeamId: 'shared-team', harnessId: 'deepseek-harness' }, randomUUID())
    const version = await builder.versionCreate('shared', resource.id, 1, randomUUID(), '')
    await builder.deploymentActivate('shared', resource.id, version.id, 0, randomUUID(), 'deploy')
    await page.goto(`${scaffold.authenticatedUrl}#agents/${resource.id}`)
    const panel = page.getByRole('main', { name: 'Agents', exact: true })
    await panel.getByRole('button', { name: 'Runs', exact: true }).click()
    await panel.getByLabel('Task', { exact: true }).fill('Inspect service')
    await panel.getByRole('button', { name: 'Start Run', exact: true }).click()
    await panel.getByRole('button', { name: 'Run details', exact: true }).first().click()
    const details = page.getByRole('region', { name: 'Run details', exact: true })
    await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('SUCCEEDED')
    await details.getByText('Version test completed', { exact: true }).waitFor()
    const direct = page.url()
    await page.reload()
    await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('SUCCEEDED')
    const completed = (await builder.runList('shared', resource.id, 0)).items[0]!
    expect({ status: completed.status, input: completed.input, result: completed.result?.textPreview,
      actor: completed.createdBy, events: completed.events.map(event => event.type), version: completed.versionNumber }).toMatchSnapshot()
    expect(completed.startedAt).not.toBeNull()
    expect(completed.finishedAt).not.toBeNull()
    const trace = page.getByRole('region', { name: 'Trace', exact: true })
    await expect.poll(async () => (await trace.getAttribute('data-trace-state')) ?? await trace.innerText(), { timeout: 10000 }).toBe('complete')
    const facts = await builder.runTraceEvents('shared', resource.id, completed.id)
    expect({ types: facts.items.map(item => item.type), modelCalls: facts.trace.modelCalls,
      toolCalls: facts.trace.toolCalls, tokens: facts.trace.totalTokens }).toMatchSnapshot()
    expect(facts.trace).toMatchObject({ modelCalls: 2, toolCalls: 1, totalTokens: 330, usageComplete: true })
    await trace.locator('[data-trace-event="tool.call.started"] summary').click()
    await trace.getByText('{"overdueOnly":true}', { exact: true }).waitFor()
    await page.screenshot({ path: '../docs/verification/agent-trace-success.png', fullPage: true })
    await trace.screenshot({ path: '../docs/verification/agent-trace-timeline.png' })

    const release = Promise.withResolvers<undefined>()
    model.hold = release.promise
    model.entered = Promise.withResolvers<undefined>()
    const running = await builder.runStart('shared', resource.id, 'Hold for cancellation', randomUUID())
    await model.entered.promise
    try {
      await page.goto(`${scaffold.authenticatedUrl}#agents/${resource.id}/runs/${running.id}`)
      await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('RUNNING')
      await details.getByRole('button', { name: 'Cancel Run', exact: true }).click()
      await details.getByRole('button', { name: 'Cancelling…', exact: true }).waitFor()
      await expect.poll(async () => (await builder.runGet('shared', resource.id, running.id)).cancelRequestedAt,
        { timeout: 10000 }).not.toBeNull()
      expect((await builder.runGet('shared', resource.id, running.id)).status).toBe('RUNNING')
    } finally { release.resolve(undefined); model.hold = null }
    await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('CANCELLED')
    expect(await details.getByRole('button', { name: 'Cancel Run', exact: true }).count()).toBe(0)
    await page.screenshot({ path: '../docs/verification/agent-run-cancelled.png', fullPage: true })

    model.fail = true
    const failed = await builder.runStart('shared', resource.id, 'Fail this task', randomUUID())
    await page.goto(`${scaffold.authenticatedUrl}#agents/${resource.id}/runs/${failed.id}`)
    await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('FAILED')
    await details.getByRole('alert').filter({ hasText: 'Model execution failed' }).waitFor()
    await panel.getByLabel('Run status', { exact: true }).selectOption('FAILED')
    await expect.poll(() => panel.locator('[data-run]').count(), { timeout: 10000 }).toBe(1)
    await page.goto(direct)
    await expect.poll(() => details.getAttribute('data-run-status'), { timeout: 10000 }).toBe('SUCCEEDED')
    expect((await builder.runGet('shared', resource.id, completed.id)).finishedAt).toBe(completed.finishedAt)
    expect(errors).toEqual([])
    await scaffold.close()
    await launch()
    await page.goto(`${scaffold.authenticatedUrl}#agents/${resource.id}/runs/${completed.id}`)
    await expect.poll(() => trace.getAttribute('data-trace-state'), { timeout: 10000 }).toBe('complete')
    expect((await scaffold.ctx.agentBuilder.runTraceEvents('shared', resource.id, completed.id)).trace).toEqual(facts.trace)
  }, 120_000)
})
