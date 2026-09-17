import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { discoverMcpServer, prepareMcpTools, type Config } from '../src/index.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose() })
async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
  close.push(() => ctx.fiber.dispose())
  const tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object' as const, properties: {} } }]
  const calls: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number
        method: string
        params?: { protocolVersion: string } }
      if (message.id === undefined) { res.writeHead(202); res.end(); return }
      const result = message.method === 'initialize' ? { protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : message.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'result' }] }
      if (message.method === 'tools/call') calls.push(req.headers.authorization ?? '')
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
    server.closeAllConnections()
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing listener')
  const config: Config = { transport: 'streamable-http', serverName: 'fixture', url: `http://127.0.0.1:${address.port}`,
    headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true }
  return { ctx, config, tools, calls }
}
it('refreshes credentials without introducing an extra tool pipeline and refuses descriptor drift before calling', async () => {
  const f = await fixture()
  let secret = 'first'
  const selection = await discoverMcpServer(f.config, new AbortController().signal)
  const definitions = await prepareMcpTools(f.ctx, [{ ...selection[0]!, publicName: 'bound' }],
    async () => ({ ...f.config, headers: { Authorization: secret } }), new AbortController().signal)
  f.ctx.tools.register(definitions[0]!)
  let observed = 0
  f.ctx.on('tools/result', () => { observed++; return undefined })
  const invoke = () => f.ctx.tools.execute({ callId: ToolCallId(String(observed)), name: 'bound', arguments: {}, signal: new AbortController().signal })
  expect((await invoke()).isError).toBe(false)
  secret = 'rotated'
  expect((await invoke()).isError).toBe(false)
  expect(f.calls).toEqual(['first', 'rotated'])
  expect(observed).toBe(2)
  f.tools[0]!.description = 'Changed'
  expect((await invoke()).isError).toBe(true)
  expect(f.calls).toHaveLength(2)
})
it('does not connect or call after its execution owner is cancelled', async () => {
  const f = await fixture()
  const owner = new AbortController()
  const definitions = await prepareMcpTools(f.ctx, f.tools, async () => f.config, owner.signal)
  f.ctx.tools.register(definitions[0]!)
  owner.abort()
  const result = await f.ctx.tools.execute({ callId: ToolCallId('cancelled'), name: definitions[0]!.name,
    arguments: {}, signal: new AbortController().signal })
  expect(result.isError).toBe(true)
  expect(f.calls).toEqual([])
})
