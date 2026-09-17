/** Test-only process boundary for hard-crash persistence evidence. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy'
import { AgentRegistry } from '../../src/registry.ts'
import { AgentVersions } from '../../src/versions.ts'
import { AgentDeployments } from '../../src/deployments.ts'
import { PlatformRuns } from '../../src/platform-runs.ts'
import { runtimePolicySchema } from '../../src/runtime-policy.ts'

const root = process.argv[2] ?? ''
const mode = process.argv[3] ?? ''
if (!root || !mode) throw new Error('Expected isolated root and crash phase')
const keepAlive = setInterval(() => {}, 1000)
const marker = (value: unknown) => { process.stdout.write(`RUNTIME ${JSON.stringify(value)}\n`) }
const ctx = new Context()
await ctx.plugin(Storage)
const backend = new JsonStorageBackend(join(root, 'storage'))
const openUnit = backend.kv.open.bind(backend.kv)
backend.kv.open = async (descriptor) => {
  const unit = await openUnit(descriptor)
  const put = unit.putRecord.bind(unit)
  unit.putRecord = async (table, key, value) => {
    if (typeof value === 'object' && value !== null
      && ((mode === 'completion' && 'status' in value && value.status === 'SUCCEEDED')
        || (mode === 'unstarted' && 'state' in value && value.state === 'DISPATCHING'))) {
      marker({ phase: mode }); await new Promise<void>(() => {})
    }
    await put(table, key, value)
  }
  return unit
}
ctx.storage.backend.register('json', backend)
const storage = new DomainFacility(ctx, { backend: 'json' })
ctx.storage.mount('domain', storage)
ctx.provide('storageDomain', storage)
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Checkpoints)
class Model extends LlmAdapter {
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(): AsyncIterable<StreamChunk> {
    await appendFile(join(root, 'model-requests.txt'), 'request\n')
    if (mode === 'model') { marker({ phase: 'model' }); await new Promise<void>(() => {}); return }
    if (mode === 'tool' || mode === 'unstarted') {
      const id = ToolCallId('external-write')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Recovered task' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recovered task' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['mock'], new Model())
ctx.tools.register({ name: 'write', description: 'External operation', parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
  execute: async () => {
    await appendFile(join(root, 'external-effects.txt'), 'committed\n')
    if (mode === 'tool') { marker({ phase: 'tool' }); await new Promise<void>(() => {}) }
    return 'committed'
  } })
// The driver owns only API composition; Harness owns every model and tool step.
ctx.provide('sessionController', { create: async ({ sessionId }: { sessionId: string }) => {
  if (ctx.agents.get(SessionId(sessionId)) !== undefined) return
  try { await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: { provider: 'mock', model: 'test' } }) }
  catch (error) {
    if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    await ctx.agents.create({ sessionId: SessionId(sessionId), agentOptions: { provider: 'mock', model: 'test' } })
  }
} } as unknown as Context['sessionController'])
const registry = await AgentRegistry.open(storage, { id: 'ws', name: 'Workspace', ownerTeamId: 'team', ownerTeamName: 'Team', accessMode: 'shared-host' })
const versions = await AgentVersions.open(storage, registry)
const deployments = await AgentDeployments.open(storage, registry, versions)
const runs = await PlatformRuns.open(ctx, registry, versions, deployments, root)
const prepare = async () => {}
let identity: { agentId: string; runId: string }
if (['admitted', 'model', 'tool', 'completion', 'unstarted'].includes(mode)) {
  const agent = await registry.create('ws', { name: 'Crash task', prompt: 'Complete task', description: '', tags: [],
    harnessId: 'deepseek-harness', ownerTeamId: 'team', model: { provider: 'mock', model: 'test' }, toolIds: [] }, randomUUID())
  const version = await versions.create('ws', agent.id, 1, randomUUID(), '', prepare)
  await deployments.activate('ws', agent.id, version.id, 0, randomUUID(), 'deploy', prepare)
  const run = await runs.start('ws', agent.id, 'Accepted task', randomUUID(), prepare)
  identity = { agentId: agent.id, runId: run.id }
  await writeFile(join(root, 'identity.json'), JSON.stringify(identity))
  if (mode === 'admitted') { marker({ phase: 'admitted' }); await new Promise<void>(() => {}) }
} else identity = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8')) as typeof identity
runs.startWorkers(runtimePolicySchema.parse({ pollMs: 20, checkpointMs: 100 }), prepare)
if (['model', 'tool', 'completion', 'unstarted'].includes(mode)) await new Promise<void>(() => {})
if (mode === 'resolve') {
  await runs.resolve('ws', identity.agentId, identity.runId, 'external-write', 'completed', 'External operation audit verified', randomUUID())
}
for (;;) {
  const run = await runs.get('ws', identity.agentId, identity.runId)
  if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(run.status)) {
    marker({ phase: 'settled', status: run.status, attempt: run.runtime?.attempt, result: run.result?.textPreview, error: run.error?.code })
    break
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}
await runs.close(); await deployments.close(); await versions.close(); await registry.close()
await ctx.fiber.dispose(); await backend.close()
clearInterval(keepAlive)
