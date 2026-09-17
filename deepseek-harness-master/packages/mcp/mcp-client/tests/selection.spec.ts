import { afterEach, expect, it, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { syncTools } from '../src/tools.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
const read = { name: 'read', description: 'Read', inputSchema: { type: 'object' as const, properties: {} } }
const write = { ...read, name: 'write', description: 'Write' }
async function fixture() {
  const ctx = new Context(); roots.push(ctx)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, {}) }, { inject: ['tools'] }))
  const request = vi.fn(async () => ({ tools: [read, write] }))
  const client = { request } as unknown as Client
  const options = { registrationFailure: 'throw' as const, serverName: 'srv', toolCallTimeoutMs: 1000,
    selection: [{ ...read, publicName: 'pinned_read' }] }
  return { ctx, scope, client, request, options }
}
it('registers only explicitly selected tools in one scope and keeps root and sibling schemas empty', async () => {
  const { ctx, scope, client, options } = await fixture()
  const sibling = createScope(scope.ctx, {})
  await syncTools(client, scope.ctx, options, new Map())
  expect(scope.ctx.tools.schemas(scopeOf(scope.ctx)).map(tool => tool.name)).toEqual(['pinned_read'])
  expect(ctx.tools.schemas()).toEqual([])
  expect(sibling.ctx.tools.schemas(scopeOf(sibling.ctx))).toEqual([])
  expect(scope.ctx.tools.get('mcp__srv__write', scopeOf(scope.ctx))).toBeUndefined()
  await scope.dispose(); await sibling.dispose()
})
it('treats an empty selection as no tools and never expands it on a subsequent sync', async () => {
  const { scope, client, options } = await fixture()
  const empty = { ...options, selection: [] }
  const previous = await syncTools(client, scope.ctx, empty, new Map())
  await syncTools(client, scope.ctx, empty, previous)
  expect(scope.ctx.tools.schemas(scopeOf(scope.ctx))).toEqual([])
  await scope.dispose()
})
it('revokes the previous generation when a selected descriptor changes', async () => {
  const { scope, client, request, options } = await fixture()
  const previous = await syncTools(client, scope.ctx, options, new Map())
  request.mockResolvedValue({ tools: [{ ...read, description: 'Changed' }, write] })
  await expect(syncTools(client, scope.ctx, options, previous)).rejects.toThrow('selected tool')
  expect(scope.ctx.tools.schemas(scopeOf(scope.ctx))).toEqual([])
  await scope.dispose()
})
it('rejects missing selections while ignoring newly discovered unselected tools', async () => {
  const { scope, client, request, options } = await fixture()
  const previous = await syncTools(client, scope.ctx, options, new Map())
  request.mockResolvedValue({ tools: [read, write, { ...write, name: 'delete_all' }] })
  const next = await syncTools(client, scope.ctx, options, previous)
  expect(scope.ctx.tools.schemas(scopeOf(scope.ctx)).map(tool => tool.name)).toEqual(['pinned_read'])
  request.mockResolvedValue({ tools: [write] })
  await expect(syncTools(client, scope.ctx, options, next)).rejects.toThrow('selected tool')
  expect(scope.ctx.tools.schemas(scopeOf(scope.ctx))).toEqual([])
  await scope.dispose()
})
