/** Local MemoryStore entries and Eval Dataset items under verified resource namespaces. */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SharedResources } from './shared-resources.ts'
import type { ResourceRef } from './resource-types.ts'
const keySchema = z.string().min(1).max(200)
const valueSchema = z.string().max(32000)
const spec = defineDomain({ name: 'platform_resource_data', version: 1, tables: {
  entries: domainTable(z.object({ workspaceId: z.string(), resourceId: z.string(), key: keySchema, value: valueSchema })),
} })
/** Resource adapters have no default namespace or arbitrary filesystem paths. */
export class WorkspaceResourceData {
  private constructor(private readonly domain: Domain<typeof spec>) {}
  /** Open the local adapter's durable entries.
   * @param storage - configured Domain facility.
   * @returns adapter owner.
   */
  static async open(storage: DomainFacility): Promise<WorkspaceResourceData> { return new WorkspaceResourceData(await storage.open(spec)) }
  /** Release the adapter after its consumers have stopped. */
  async close(): Promise<void> { await this.domain.close() }
  /** Read one value after resolving its parent resource in the caller's space.
   * @param resources - explicitly scoped directory.
   * @param ref - pinned MemoryStore or Eval Dataset.
   * @param kind - expected resource kind.
   * @param key - local entry key.
   * @returns saved value or null.
   */
  read(resources: SharedResources, ref: ResourceRef, kind: 'memory-store' | 'eval-dataset', key: string): string | null {
    resources.binding(ref, kind, true)
    return this.domain.table('entries').get(JSON.stringify([resources.workspaceId, ref.resourceId, keySchema.parse(key)]))?.value ?? null
  }
  /** Write a bounded value into a verified parent resource.
   * @param resources - explicitly scoped directory.
   * @param ref - pinned MemoryStore or Eval Dataset.
   * @param kind - expected resource kind.
   * @param key - local entry key.
   * @param value - bounded text or dataset item JSON.
   */
  async put(resources: SharedResources, ref: ResourceRef, kind: 'memory-store' | 'eval-dataset', key: string,
    value: string): Promise<void> {
    resources.binding(ref, kind, true)
    const row = { workspaceId: resources.workspaceId, resourceId: ref.resourceId, key: keySchema.parse(key),
      value: valueSchema.parse(value) }
    await this.domain.table('entries').put(JSON.stringify([row.workspaceId, row.resourceId, row.key]), row)
  }
}
