/** Per-operation resource resolution for the existing Harness ToolRuntime. */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SharedResources } from './shared-resources.ts'
import { RegistryError } from './registry.ts'
import type { ResourceManifest } from './resource-types.ts'
import type { WorkspaceResourceData } from './workspace-resource-data.ts'

const output: ToolDefinition['output'] = { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

/** Register only bound tools in the Agent scope before prompt/schema assembly.
 * @param agent - Harness execution owner.
 * @param resources - directory fixed to the persisted Run workspace.
 * @param manifest - validated AgentVersion resources.
 * @param data - local Memory adapter.
 */
export function mountWorkspaceTools(agent: Agent, resources: SharedResources, manifest: ResourceManifest,
  data: WorkspaceResourceData): void {
  resources.assertAvailable(manifest)
  const memoryStores = manifest.memoryStores ?? []
  if (memoryStores.length === 0) return
  for (const write of [false, true]) {
    agent.ctx.effect(() => agent.ctx.tools.register({ name: write ? 'platform_memory_put' : 'platform_memory_get',
      description: `Access bound MemoryStore entries: ${memoryStores.map(row => `${row.resourceId} (${row.name})`).join(', ')}`,
      parameters: { type: 'object', properties: { storeId: { type: 'string' }, key: { type: 'string' },
        ...(write ? { value: { type: 'string' } } : {}) },
      required: write ? ['storeId', 'key', 'value'] : ['storeId', 'key'], additionalProperties: false }, output,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        resources.assertAvailable(manifest)
        const input = z.object({ storeId: z.string(), key: z.string(), value: z.string().optional() }).parse(args)
        const store = memoryStores.find(row => row.resourceId === input.storeId)
        if (store === undefined) throw new RegistryError('not-found', 'MemoryStore not bound to this Agent version')
        const ref = { resourceId: store.resourceId, versionId: store.id }
        if (write) await data.put(resources, ref, 'memory-store', input.key, z.string().parse(input.value))
        return { value: data.read(resources, ref, 'memory-store', input.key) }
      },
    }), write ? 'platform.memory.write' : 'platform.memory.read')
  }
}
