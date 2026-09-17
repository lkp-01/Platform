import { GovernanceError } from '../src/governance.ts'
import type { PlatformRun } from '../src/types.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LlmRuntime, { HarnessError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as Checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { AgentRegistry } from '../src/registry.ts'
import { AgentVersions } from '../src/versions.ts'
import { AgentDeployments } from '../src/deployments.ts'
import { PlatformRuns } from '../src/platform-runs.ts'
import { runtimePolicySchema, type RuntimePolicy } from '../src/runtime-policy.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const prepare = async () => {}

async function fixture(adapter: MockAdapter, options: Partial<RuntimePolicy> = {}, path?: string, workerPrepare = prepare, authorize?: (run: PlatformRun) => void, prepareTools?: Parameters<PlatformRuns['startWorkers']>[3]) {
  const root = path ?? await mkdtemp(join(tmpdir(), 'reliable-runtime-'))
  if (path === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'storage'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Agents)
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Checkpoints)
  ctx.llm.registerAdapter(['mock'], adapter)
  // Unit fixture replaces only API composition; execution and persistence are real Harness services.
  ctx.provide('sessionController', { create: async ({ sessionId }: { sessionId: string }) => {
    if (ctx.agents.get(SessionId(sessionId)) !== undefined) return
    try { await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'mock', model: 'test' } }) }
    catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      await ctx.agents.create({ sessionId: SessionId(sessionId), agentOptions: { provider: 'mock', model: 'test' } })
    }
  } } as unknown as Context['sessionController'])
  const registry = await AgentRegistry.open(facility, { id: 'ws', name: 'Workspace', ownerTeamId: 'team', ownerTeamName: 'Team', accessMode: 'shared-host' })
  const versions = await AgentVersions.open(facility, registry)
  const deployments = await AgentDeployments.open(facility, registry, versions)
  const runs = await PlatformRuns.open(ctx, registry, versions, deployments, root)
  runs.startWorkers(runtimePolicySchema.parse({ pollMs: 20, checkpointMs: 100, ...options }), workerPrepare, authorize, prepareTools)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await runs.close(); await deployments.close(); await versions.close(); await registry.close()
    await ctx.fiber.dispose(); await backend.close()
  }
  cleanup.push(close)
  const makeAgent = async () => {
    const agent = await registry.create('ws', { name: 'Reliable', prompt: 'Complete the task', description: '', tags: [],
      harnessId: 'deepseek-harness', ownerTeamId: 'team', model: { provider: 'mock', model: 'test' }, toolIds: [] }, randomUUID())
    const version = await versions.create('ws', agent.id, 1, randomUUID(), '', prepare)
    await deployments.activate('ws', agent.id, version.id, 0, randomUUID(), 'deploy', prepare)
    return agent
  }
  return { root, ctx, registry, versions, deployments, runs, makeAgent, close }
}

describe('reliable Platform execution over Harness', () => {
  it('cancels pending scoped tool preparation before any model request', async () => {
    const model = new MockAdapter([textResponse('must not execute')])
    let preparing = false
    let aborted = false
    const runtime = await fixture(model, {}, undefined, prepare, undefined, async (_run, _agent, signal) => {
      preparing = true
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(new Error('Preparation cancelled')) }
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
      return async () => {}
    })
    const agent = await runtime.makeAgent()
    const run = await runtime.runs.start('ws', agent.id, 'cancel during discovery', randomUUID(), prepare)
    await expect.poll(() => preparing).toBe(true)
    await runtime.runs.cancel('ws', agent.id, run.id)
    await expect.poll(async () => (await runtime.runs.get('ws', agent.id, run.id)).status).toBe('CANCELLED')
    expect(aborted).toBe(true)
    expect(model.requests).toHaveLength(0)
  })

  it('refuses queued recovery after execution authority is revoked', async () => {
    const first = await fixture(new MockAdapter([]), { pollMs: 60000 })
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'revoked admission', randomUUID(), prepare)
    await first.close()
    const model = new MockAdapter([textResponse('must not execute')])
    const second = await fixture(model, {}, first.root, prepare, () => { throw new GovernanceError(403, 'Revoked') })
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('FAILED')
    expect((await second.runs.get('ws', agent.id, run.id)).error?.code).toBe('AUTHORIZATION_REVOKED')
    expect(model.requests).toHaveLength(0)
  })

  it('does not retry an external tool after its caller loses permission', async () => {
    let allowed = true
    const model = new MockAdapter([toolCallResponse('revoked-call', 'read', {}), textResponse('must not run')])
    const f = await fixture(model, { replaySafeTools: ['read'], retryDelayMs: 20 }, undefined, prepare,
      () => { if (!allowed) throw new GovernanceError(403, 'Revoked') })
    let effects = 0
    f.ctx.tools.register({ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => { effects++; allowed = false; throw new HarnessError('Temporary reset', 'ECONNRESET') } })
    const agent = await f.makeAgent()
    const run = await f.runs.start('ws', agent.id, 'read once', randomUUID(), prepare)
    await expect.poll(async () => (await f.runs.get('ws', agent.id, run.id)).status).toBe('FAILED')
    expect(effects).toBe(1)
    expect(model.requests).toHaveLength(1)
  })

  it('waits for a temporarily unavailable provider before executing the captured task', async () => {
    let prepared = 0
    const model = new MockAdapter([textResponse('ready')])
    const f = await fixture(model, { retryDelayMs: 20 }, undefined, async () => {
      if (++prepared === 1) throw Object.assign(new Error('Provider is starting'), { code: 'session/model-unavailable' })
    })
    const agent = await f.makeAgent()
    const run = await f.runs.start('ws', agent.id, 'wait for provider', randomUUID(), prepare)
    await expect.poll(async () => (await f.runs.get('ws', agent.id, run.id)).status).toBe('SUCCEEDED')
    expect(prepared).toBe(2)
    expect(model.requests).toHaveLength(1)
    expect((await f.runs.get('ws', agent.id, run.id)).events.some(event => event.type === 'run.retry-scheduled')).toBe(true)
  })

  it('recovers an admission that was never handed to a worker', async () => {
    const first = await fixture(new MockAdapter([]), { pollMs: 60000 })
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'queued task', randomUUID(), prepare)
    await first.close()
    const model = new MockAdapter([textResponse('done')])
    const second = await fixture(model, {}, first.root)
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('SUCCEEDED')
    expect(model.requests).toHaveLength(1)
  })

  it('durably admits once, bounds worker concurrency and cancels a queued task without dispatch', async () => {
    const model = new MockAdapter(['hang', textResponse('done')])
    const f = await fixture(model, { concurrency: 1 })
    const agent = await f.makeAgent()
    const token = randomUUID()
    const [one, duplicate] = await Promise.all([f.runs.start('ws', agent.id, 'first', token, prepare), f.runs.start('ws', agent.id, 'first', token, prepare)])
    expect(one.id).toBe(duplicate.id)
    await expect.poll(() => model.requests.length).toBe(1)
    const two = await f.runs.start('ws', agent.id, 'second', randomUUID(), prepare)
    expect((await f.runs.get('ws', agent.id, two.id)).status).toBe('PENDING')
    await f.runs.cancel('ws', agent.id, two.id)
    expect((await f.runs.get('ws', agent.id, two.id)).status).toBe('CANCELLED')
    await f.runs.cancel('ws', agent.id, one.id)
    await expect.poll(async () => (await f.runs.get('ws', agent.id, one.id)).status).toBe('CANCELLED')
    expect(model.requests).toHaveLength(1)
  })

  it('resumes the same accepted Run after shutdown without submitting the original input twice', async () => {
    const model = new MockAdapter(['hang'])
    const first = await fixture(model)
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'original task', randomUUID(), prepare)
    await expect.poll(() => model.requests.length).toBe(1)
    await first.close()
    const resumedModel = new MockAdapter([textResponse('recovered')])
    const second = await fixture(resumedModel, {}, first.root)
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('SUCCEEDED')
    const result = await second.runs.get('ws', agent.id, run.id)
    expect(result.runtime?.attempt).toBe(2)
    expect(result.result?.textPreview).toBe('recovered')
    const events = second.ctx.agents.get(run.sessionId)!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === 'original task'))).toHaveLength(1)
  })

  it('retries a declared safe transient tool through all guards with the original call identity', async () => {
    const model = new MockAdapter([toolCallResponse('call-a', 'read', {}), textResponse('done')])
    const f = await fixture(model, { replaySafeTools: ['read'], retryDelayMs: 20 })
    let calls = 0
    let guards = 0
    const ids: string[] = []
    f.ctx.tools.guard(() => { guards++; return undefined })
    f.ctx.tools.register({ name: 'read', description: 'Read only', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        calls++; ids.push(exec.callId)
        if (calls === 1) throw new HarnessError('Temporary reset', 'ECONNRESET')
        return 'read result'
      } })
    const agent = await f.makeAgent()
    const run = await f.runs.start('ws', agent.id, 'read it', randomUUID(), prepare)
    await expect.poll(async () => await f.runs.get('ws', agent.id, run.id).then(row => row.error?.message ?? row.status)).toBe('SUCCEEDED')
    expect(calls).toBe(2)
    expect(guards).toBe(2)
    expect(ids).toEqual(['call-a', 'call-a'])
    expect(model.requests).toHaveLength(2)
  })

  it('holds exclusive Host ownership and preserves already completed results on reopen', async () => {
    const model = new MockAdapter([textResponse('final')])
    const first = await fixture(model)
    await expect(PlatformRuns.open(first.ctx, first.registry, first.versions, first.deployments, first.root)).rejects.toThrow('already owned')
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'task', randomUUID(), prepare)
    await expect.poll(async () => await first.runs.get('ws', agent.id, run.id).then(row => row.error?.message ?? row.status)).toBe('SUCCEEDED')
    await first.close()
    const nextModel = new MockAdapter([])
    const second = await fixture(nextModel, {}, first.root)
    expect((await second.runs.get('ws', agent.id, run.id)).result?.textPreview).toBe('final')
    expect(nextModel.requests).toHaveLength(0)
  })

  it('blocks an interrupted write and accepts verified completion without executing it again', async () => {
    const first = await fixture(new MockAdapter([toolCallResponse('write-a', 'write', {})]))
    let writes = 0
    first.ctx.tools.register({ name: 'write', description: 'External write', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        writes++
        await new Promise<void>((resolve) =>{  exec.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return 'external operation may have completed'
      } })
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'write it', randomUUID(), prepare)
    await expect.poll(() => writes).toBe(1)
    await first.close()
    const model = new MockAdapter([textResponse('confirmed')])
    const second = await fixture(model, {}, first.root)
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('BLOCKED')
    expect(model.requests).toHaveLength(0)
    const token = randomUUID()
    await second.runs.resolve('ws', agent.id, run.id, 'write-a', 'completed', 'Database audit operation 42 committed', token)
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('SUCCEEDED')
    expect(writes).toBe(1)
    expect(model.requests[0]!.messages.some(message => JSON.stringify(message).includes('Database audit operation 42 committed'))).toBe(true)
    expect((await second.runs.resolve('ws', agent.id, run.id, 'write-a', 'completed', 'Database audit operation 42 committed', token)).status).toBe('SUCCEEDED')
    await expect(second.runs.resolve('ws', agent.id, run.id, 'write-a', 'not-executed', 'different evidence', token)).rejects.toThrow('different evidence')
  })

  it('persists cancellation during retry backoff and never dispatches it after restart', async () => {
    const first = await fixture(new MockAdapter([toolCallResponse('read-a', 'read', {})]), { replaySafeTools: ['read'], retryDelayMs: 5000 })
    let calls = 0
    first.ctx.tools.register({ name: 'read', description: 'Read only', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
      execute: async () => { calls++; throw new HarnessError('Reset', 'ECONNRESET') } })
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'read it', randomUUID(), prepare)
    await expect.poll(async () => (await first.runs.get('ws', agent.id, run.id)).status).toBe('RETRY_WAIT')
    await first.runs.cancel('ws', agent.id, run.id)
    await first.close()
    const model = new MockAdapter([])
    const second = await fixture(model, {}, first.root)
    expect((await second.runs.get('ws', agent.id, run.id)).status).toBe('CANCELLED')
    expect(calls).toBe(1)
    expect(model.requests).toHaveLength(0)
  })

  it('checkpoints a long-running model and stops at the captured deadline', async () => {
    const model = new MockAdapter(['hang'])
    const f = await fixture(model, { deadlineMs: 1000 })
    const agent = await f.makeAgent()
    const run = await f.runs.start('ws', agent.id, 'bounded task', randomUUID(), prepare)
    await expect.poll(async () => (await f.runs.get('ws', agent.id, run.id)).runtime?.checkpointAt).not.toBeNull()
    await expect.poll(async () => (await f.runs.get('ws', agent.id, run.id)).status).toBe('FAILED')
    expect((await f.runs.get('ws', agent.id, run.id)).error?.code).toBe('DEADLINE_EXCEEDED')
    expect(model.requests).toHaveLength(1)
  })

  it('executes an uncertain write only after an explicit verified non-execution decision', async () => {
    const first = await fixture(new MockAdapter([toolCallResponse('write-b', 'write', {})]))
    const entered = Promise.withResolvers<undefined>()
    first.ctx.tools.register({ name: 'write', description: 'Write', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'write result' }] },
      execute: async (_args, exec) => {
        entered.resolve(undefined)
        await new Promise<void>((resolve) => { exec.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return 'not executed'
      } })
    const agent = await first.makeAgent()
    const run = await first.runs.start('ws', agent.id, 'write once', randomUUID(), prepare)
    await entered.promise
    await first.close()
    const second = await fixture(new MockAdapter([textResponse('done')]), {}, first.root)
    let effects = 0
    second.ctx.tools.register({ name: 'write', description: 'Write', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'committed' }] },
      execute: async () => { effects++; return 'committed' } })
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('BLOCKED')
    expect(effects).toBe(0)
    await second.runs.resolve('ws', agent.id, run.id, 'write-b', 'not-executed', 'External operation log confirms no dispatch', randomUUID())
    await expect.poll(async () => (await second.runs.get('ws', agent.id, run.id)).status).toBe('SUCCEEDED')
    expect(effects).toBe(1)
  })
})
