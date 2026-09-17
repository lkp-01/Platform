/** Pinned MCP descriptions shared by discovery and managed registration. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { McpDescriptor, McpSelection } from './types.ts'
export type { McpDescriptor, McpSelection } from './types.ts'

/** Public MCP description; raw names never encode authorization. */
export const mcpDescriptorSchema = z.strictObject({
  name: z.string().min(1).max(512), description: z.string(),
  inputSchema: z.record(z.string(), z.json()),
  outputSchema: z.record(z.string(), z.json()).optional(),
  taskRequired: z.boolean().optional(),
})
/** Exact description and optional stable model-facing alias. */
export const mcpSelectionSchema = mcpDescriptorSchema.extend({ publicName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() })

/** Resolve selected descriptions without admitting new server capabilities.
 * @param discovered - complete current tool list.
 * @param selection - pinned descriptions; an empty list authorizes nothing.
 * @returns selected descriptors in binding order.
 */
export function selectMcpTools(discovered: McpDescriptor[], selection: McpSelection[]): McpSelection[] {
  const selected = z.array(mcpSelectionSchema).parse(selection)
  if (new Set(selected.map(tool => tool.name)).size !== selected.length) throw new Error('Duplicate selected tool')
  for (const expected of selected) {
    const actual = discovered.find(tool => tool.name === expected.name)
    const { publicName: _alias, ...descriptor } = expected
    if (actual === undefined || !isDeepStrictEqual({ ...actual, taskRequired: actual.taskRequired ?? false },
      { ...descriptor, taskRequired: descriptor.taskRequired ?? false })) throw new Error('MCP selected tool is missing or its description changed')
  }
  return selected
}
