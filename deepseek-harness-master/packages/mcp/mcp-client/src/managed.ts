/** Short-lived managed connections reuse the native MCP bridge and refresh credentials per operation. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Config } from './index.ts'
import { createTransport } from './transport.ts'
import { discoverClientTools, selectedToolDefinition, type McpInvoker } from './tools.ts'
import { selectMcpTools, type McpDescriptor, type McpSelection } from './selection.ts'

async function connected<T>(config: Config, signal: AbortSignal, action: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const operation = AbortSignal.any([signal, AbortSignal.timeout(config.toolCallTimeoutMs)])
  const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, { capabilities: {} })
  try {
    await client.connect(createTransport(config), { signal: operation, timeout: config.toolCallTimeoutMs })
    operation.throwIfAborted()
    return await action(client, operation)
  } finally { await client.close() }
}

/** Discover without contributing tools to any Host or Agent registry.
 * @param config - transient connection configuration, including resolved credentials.
 * @param signal - discovery cancellation.
 * @returns complete descriptions after the connection has closed.
 */
export function discoverMcpServer(config: Config, signal: AbortSignal): Promise<McpDescriptor[]> {
  return connected(config, signal, (client, operation) => discoverClientTools(client,
    { signal: operation, timeout: config.toolCallTimeoutMs }))
}

/** Prepare native definitions with one serialized, credential-refreshing connection per invocation.
 * @param ctx - native bridge capability context.
 * @param selection - exact authorized descriptions and public names.
 * @param resolve - resolves current availability and credentials without persisting secrets.
 * @param signal - execution-owner cancellation; abort prevents queued calls from connecting.
 * @returns validated native definitions; the owner registers them in its Agent scope.
 */
export async function prepareMcpTools(ctx: Context, selection: McpSelection[], resolve: () => Promise<Config>,
  signal: AbortSignal): Promise<ToolDefinition[]> {
  const pinned = structuredClone(selection)
  const initial = await resolve()
  selectMcpTools(await discoverMcpServer(initial, signal), pinned)
  let tail: Promise<unknown> = Promise.resolve()
  const invoke: McpInvoker = (name, args, exec) => {
    const result = tail.then(async () => {
      const operation = AbortSignal.any([signal, exec.signal])
      operation.throwIfAborted()
      const config = await resolve()
      return connected(config, operation, async (client, active) => {
        selectMcpTools(await discoverClientTools(client, { signal: active, timeout: config.toolCallTimeoutMs }), pinned)
        // Recheck resource availability after asynchronous discovery and before dispatch.
        await resolve()
        active.throwIfAborted()
        return client.request({ method: 'tools/call', params: { name, arguments: args } },
          z.record(z.string(), z.unknown()), { signal: active, timeout: config.toolCallTimeoutMs })
      })
    })
    tail = result.catch(() => undefined)
    return result
  }
  return pinned.map(tool => selectedToolDefinition(invoke, ctx, tool,
    { registrationFailure: 'throw', serverName: initial.serverName, toolCallTimeoutMs: initial.toolCallTimeoutMs }))
}
