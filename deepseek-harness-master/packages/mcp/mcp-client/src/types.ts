/** Persistable MCP tool descriptions shared by managed resource APIs. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Raw MCP tool description, excluding transport credentials. */
export interface McpDescriptor {
  /** Exact raw operation name returned by tools/list. */
  name: string
  /** Model-visible description pinned at publication. */
  description: string
  /** Complete JSON input schema used for argument validation. */
  inputSchema: Record<string, JsonValue>
  /** Optional JSON result schema advertised by the server. */
  outputSchema?: Record<string, JsonValue> | undefined
  /** Whether the server requires MCP task execution rather than a direct call. */
  taskRequired?: boolean | undefined
}

/** Exact authorized description with an optional stable model-facing alias. */
export type McpSelection = McpDescriptor & {
  /** Stable model-visible name; omitted names use the normal server namespace. */
  publicName?: string | undefined
}
