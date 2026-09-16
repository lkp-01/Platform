import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import * as Records from '@deepseek-ai/dsh-business-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Commands from '@deepseek-ai/dsh-commands'
import AgentBuilder from '@deepseek-ai/dsh-agent-builder'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'

const root = fileURLToPath(new URL('../presets/', import.meta.url))
const contexts: Context[] = []
const temporaryRoots: string[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
afterEach(async () => { for (const path of temporaryRoots.splice(0)) await rm(path, { recursive: true, force: true }) })

async function harness(extraRoot?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(Commands)
  await ctx.plugin(Records)
  await mountAgentLoopTestHarness(ctx)
  const roots = [{ path: root, trust: 'system' as const }]
  if (extraRoot !== undefined) roots.push({ path: extraRoot, trust: 'system' })
  await ctx.plugin(AgentPresets, { default: 'customer-service', includeShippedRoot: false, includeUserRoot: false, roots })
  return ctx
}

async function agentOn(ctx: Context, preset: string) {
  return (await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'demo', model: 'demo' },
    meta: { agentPreset: preset }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) },
  })).agent
}
const call = (ctx: Context, agent: Agent, name: string, args: unknown) => ctx.tools.execute({
  callId: ToolCallId(randomUUID()), agent, name, arguments: args, signal: new AbortController().signal,
})

class ScriptedModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  errors: unknown[] = []
  constructor(private steps: ((options: GenerateOptions) => StreamChunk[])[]) { super() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async listModels(provider: string) { return ['demo', 'other'].map(id => ({ provider, id, name: id })) }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.steps.shift()
    if (!next) throw new Error('Unexpected model request')
    try { yield* next(options) } catch (error) { this.errors.push(error); throw error }
  }
}
function requestTool(name: string, args: unknown): StreamChunk[] {
  const id = ToolCallId(randomUUID())
  const value = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
const finish = (): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '完成' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } },
  { type: 'finish', reason: { kind: 'stop' } },
]
async function run(agent: Agent, prompt = '执行测试业务任务') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('business presets through the production Loader and Agent Loop', () => {
  it('creates reusable definitions and initializes distinct models through the real Session Controller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-builder-loop-'))
    temporaryRoots.push(directory)
    const ctx = await harness(directory)
    const model = new ScriptedModel([finish, finish, finish])
    ctx.llm.registerAdapter(['demo'], model)
    const controller = createSessionTestController(ctx, { cwd: directory, defaultModelSelection: () => ({ provider: 'demo', model: 'demo' }) })
    await ctx.plugin(AgentBuilder, { root: directory })
    const builder = ctx.agentBuilder
    const input = { name: 'Custom support', prompt: 'Literal {{customer}}\n!!js this is text', model: { provider: 'demo', model: 'other' }, toolIds: ['order_query', 'calendar_query'] }
    const first = await builder.create(input, randomUUID())
    const second = await builder.create({ ...input, name: 'Conversation', toolIds: [], model: { provider: 'demo', model: 'demo' } }, randomUUID())
    expect(model.requests).toEqual([])
    expect((await builder.catalog()).agents).toHaveLength(5)
    expect(await builder.get(first.id)).toEqual(first)
    const [one, two] = await Promise.all([controller.create({ agentPreset: first.id }), controller.create({ agentPreset: second.id })])
    const a = ctx.agents.get(one.sessionId)!
    const b = ctx.agents.get(two.sessionId)!
    expect(ctx.tools.schemas(a).map(tool => tool.name).sort()).toEqual(['calendar_query', 'order_query'])
    expect(ctx.tools.schemas(b)).toEqual([])
    await run(a)
    await run(b)
    expect(model.requests.map(request => request.model)).toEqual(['other', 'demo'])
    expect(JSON.stringify(model.requests[0])).toContain('Literal {{customer}}\\n!!js this is text')
    expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'demo', model: 'demo' })
    await controller.selectModel({ sessionId: one.sessionId, provider: 'demo', model: 'demo' })
    await controller.create({ sessionId: one.sessionId, agentPreset: first.id, cwd: directory })
    await run(a)
    expect(model.requests[2]!.model).toBe('demo')
    expect((await call(ctx, a, 'ticket_create', { orderId: 'O-1002', summary: 'not selected', escalated: false, requestKey: 'blocked' })).isError).toBe(true)
    await expect(builder.create({ ...input, model: { provider: 'demo', model: 'missing' } }, randomUUID())).rejects.toThrow('available catalog')
  })
  it.each([{ names: [] }, { names: ['order_query'] }, { names: ['knowledge_search', 'data_analyze', 'calendar_query'] }])('registers exactly the selected tools: $names', async ({ names }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-selected-agent-'))
    temporaryRoots.push(directory)
    const definition = join(directory, 'selected')
    await mkdir(definition)
    await writeFile(join(definition, 'agent.cordis.yml'), JSON.stringify([
      { name: '@deepseek-ai/dsh-business-tools/customer-service', config: { enabledTools: names.filter(n => ['knowledge_search', 'order_query'].includes(n)) } },
      { name: '@deepseek-ai/dsh-business-tools/data-analysis', config: { enabledTools: names.filter(n => n === 'data_analyze') } },
      { name: '@deepseek-ai/dsh-business-tools/operations', config: { enabledTools: names.filter(n => n === 'calendar_query'), businessDate: '2026-09-15' } },
    ]))
    const ctx = await harness(directory)
    const agent = await agentOn(ctx, 'selected')
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual([...names].sort())
    expect(await call(ctx, agent, 'ticket_create', { orderId: 'O-1002', summary: 'test', escalated: false, requestKey: 'unselected' })).toMatchObject({ isError: true })
    expect(ctx.sessionProjections.stateOf(agent.session, 'businessRecords')).toEqual([])
  })
  it('runs interleaved business loops with Session-local records and the same idempotency key', async () => {
    const ctx = await harness()
    const [first, second, operations] = await Promise.all([
      agentOn(ctx, 'customer-service'), agentOn(ctx, 'customer-service'), agentOn(ctx, 'operations'),
    ])
    const step = (options: GenerateOptions): StreamChunk[] => {
      const request = JSON.stringify(options)
      if (request.includes('ticket-') || request.includes('task-')) return finish()
      return request.includes('parallel-operations')
        ? requestTool('task_create', { projectId: 'P-101', ownerId: 'u-amy', title: '跟进', dueDate: '2026-09-16', requestKey: 'same-key' })
        : requestTool('ticket_create', { orderId: 'O-1002', summary: '延期', escalated: true, requestKey: 'same-key' })
    }
    const model = new ScriptedModel(Array.from({ length: 6 }, () => step))
    ctx.llm.registerAdapter(['demo'], model)
    await Promise.all([run(first, 'parallel-one'), run(second, 'parallel-two'), run(operations, 'parallel-operations')])
    expect(model.errors).toEqual([])
    expect(model.requests).toHaveLength(6)
    const records = [first, second, operations].map(agent => ctx.sessionProjections.stateOf(agent.session, 'businessRecords')!)
    expect(records.map(items => items.length)).toEqual([1, 1, 1])
    expect(records.map(items => items[0]!.kind)).toEqual(['ticket', 'ticket', 'task'])
    expect(new Set(records.map(items => items[0]!.id)).size).toBe(3)
  })
  it('adds a fourth Agent using only definition files and existing tool plugins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-fourth-agent-'))
    temporaryRoots.push(directory)
    const definition = join(directory, 'returns')
    await mkdir(definition)
    await writeFile(join(definition, 'preset.yml'), 'name: Returns Agent\ndescription: Returns support\n')
    const composition = await readFile(join(root, 'customer-service', 'agent.cordis.yml'), 'utf8')
    await writeFile(join(definition, 'agent.cordis.yml'), composition.replace('你是企业客服助手', '你是退货处理助手'))
    const ctx = await harness(directory)
    expect((await ctx.agentPresets.list()).map(item => item.id)).toContain('returns')
    const agent = await agentOn(ctx, 'returns')
    const model = new ScriptedModel([(options) => {
      expect(JSON.stringify(options)).toContain('退货处理助手')
      return finish()
    }])
    ctx.llm.registerAdapter(['demo'], model)
    await run(agent)
    expect(model.requests).toHaveLength(1)
    expect(model.errors).toEqual([])
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['knowledge_search', 'order_query', 'ticket_create'])
  })
  it('discovers three named definitions and isolates the exact executable tool sets', async () => {
    const ctx = await harness()
    const list = await ctx.agentPresets.list()
    expect(list.map(item => item.id).sort()).toEqual(['customer-service', 'data', 'operations'])
    expect(list.every(item => item.name && item.description && !item.broken)).toBe(true)
    const [customer, data, operations] = await Promise.all(['customer-service', 'data', 'operations'].map(id => agentOn(ctx, id)))
    const names = (agent: Agent) => ctx.tools.schemas(agent).map(tool => tool.name).sort()
    expect(names(customer!)).toEqual(['knowledge_search', 'order_query', 'ticket_create'])
    expect(names(data!)).toEqual(['data_analyze', 'data_catalog', 'dataset_read', 'sql_query'])
    expect(names(operations!)).toEqual(['calendar_query', 'message_send', 'project_query', 'task_create'])
    expect(new Set([customer!.id, data!.id, operations!.id]).size).toBe(3)
    for (const name of ['sql_query', 'bash', 'pwsh', 'task_create']) {
      expect((await call(ctx, customer!, name, {})).isError).toBe(true)
    }
    expect((await call(ctx, data!, 'ticket_create', {})).isError).toBe(true)
    await expect(agentOn(ctx, 'unknown')).rejects.toThrow()
  })

  it('answers from knowledge and order tools, logs one idempotent escalated ticket and keeps sessions separate', async () => {
    const ctx = await harness()
    const customer = await agentOn(ctx, 'customer-service')
    const args = { orderId: 'O-1002', summary: '发货延期', escalated: true, requestKey: 'delay-1002' }
    const model = new ScriptedModel([
      (options) => { expect(JSON.stringify(options)).toContain('企业客服助手'); return requestTool('knowledge_search', { query: '发货延期' }) },
      (options) => { expect(JSON.stringify(options)).toContain('knowledge:shipping-delay'); return requestTool('order_query', { orderId: 'O-1002' }) },
      (options) => { expect(JSON.stringify(options)).toContain('awaiting_shipment'); return requestTool('ticket_create', args) },
      () => requestTool('ticket_create', args),
      finish,
    ])
    ctx.llm.registerAdapter(['demo'], model)
    await run(customer)
    expect(model.errors).toEqual([])
    expect(model.requests).toHaveLength(5)
    const records = ctx.sessionProjections.stateOf(customer.session, 'businessRecords')!
    expect(records).toHaveLength(1)
    expect(records[0]?.payload).toMatchObject({ status: 'escalated', orderId: 'O-1002' })
    expect((await call(ctx, customer, 'ticket_create', { ...args, summary: '不同输入' })).isError).toBe(true)
    const second = await agentOn(ctx, 'customer-service')
    expect(ctx.sessionProjections.stateOf(second.session, 'businessRecords')).toEqual([])
    const result = await call(ctx, second, 'ticket_create', args)
    expect(result.isError).toBe(false)
    if (!result.isError) expect(result.value).not.toEqual(records[0])
    expect((await call(ctx, customer, 'ticket_create', { ...args, orderId: 'missing' })).isError).toBe(true)
  })

  it('computes fixture revenue and refund rates and rejects SQL/file escape attempts', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'data')
    const model = new ScriptedModel([
      () => requestTool('data_catalog', {}),
      () => requestTool('sql_query', { sql: "SELECT product, SUM(CASE WHEN period='2026-08' THEN revenue ELSE -revenue END) AS delta FROM sales GROUP BY product ORDER BY delta" }),
      (options) => { expect(JSON.stringify(options)).toContain('-40000'); return requestTool('data_analyze', { operation: 'change', values: [100000, 60000] }) },
      (options) => { expect(JSON.stringify(options)).toContain('-40'); return finish() },
    ])
    ctx.llm.registerAdapter(['demo'], model)
    await run(agent)
    expect(model.errors).toEqual([])
    expect(model.requests).toHaveLength(4)
    expect(await call(ctx, agent, 'sql_query', { sql: 'SELECT period, SUM(refunded_orders)*100.0/SUM(paid_orders) AS rate FROM sales GROUP BY period ORDER BY period' }))
      .toMatchObject({ isError: false, value: { rows: [{ period: '2026-07', rate: 2 }, { period: '2026-08', rate: 5 }] } })
    for (const sql of ['DELETE FROM sales', "ATTACH DATABASE ':memory:' AS stolen", 'PRAGMA database_list', "SELECT load_extension('x')", 'SELECT 1; DROP TABLE sales', 'SELECT * FROM sqlite_master']) {
      expect((await call(ctx, agent, 'sql_query', { sql })).isError, sql).toBe(true)
    }
    expect((await call(ctx, agent, 'dataset_read', { datasetId: '../secrets', offset: 0, limit: 1 })).isError).toBe(true)
    expect(await call(ctx, agent, 'sql_query', { sql: 'SELECT COUNT(*) AS n FROM sales' })).toMatchObject({ isError: false, value: { rows: [{ n: 6 }] } })
  })

  it('creates an owner-matched task before sending a session-local simulated notification', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'operations')
    const model = new ScriptedModel([
      () => requestTool('project_query', { overdueOnly: true }),
      (options) => { expect(JSON.stringify(options)).toContain('P-101'); return requestTool('calendar_query', { ownerId: 'u-amy', date: '2026-09-16' }) },
      () => requestTool('task_create', { projectId: 'P-101', ownerId: 'u-amy', title: '安排客户培训', dueDate: '2026-09-16', requestKey: 'followup' }),
      () => {
        const task = ctx.sessionProjections.stateOf(agent.session, 'businessRecords')!.find(item => item.kind === 'task')!
        return requestTool('message_send', { ownerId: 'u-amy', taskId: task.id, message: '请安排客户培训', requestKey: 'notice' })
      }, finish,
    ])
    ctx.llm.registerAdapter(['demo'], model)
    await run(agent)
    expect(model.errors).toEqual([])
    const records = ctx.sessionProjections.stateOf(agent.session, 'businessRecords')!
    expect(records.map(item => item.kind)).toEqual(['task', 'message'])
    expect(records[1]?.payload).toMatchObject({ status: 'mock_sent', taskId: records[0]?.id })
    const other = await agentOn(ctx, 'operations')
    expect((await call(ctx, other, 'message_send', { ownerId: 'u-amy', taskId: records[0]!.id, message: 'x', requestKey: 'x' })).isError).toBe(true)
  })
})
