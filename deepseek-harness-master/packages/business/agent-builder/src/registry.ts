/** Durable resource ownership and editable drafts, separate from executable Presets. */
import { platformActor } from './principal-context.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { agentResourcesSchema } from './resource-schema.ts'
import { inputSchema, tokenSchema } from './definition.ts'
import type { RegistryAgent, RegistryAgentId, RegistryAgentInput, RegistryPage, RegistryQuery, RegistryWorkspace } from './types.ts'

/** Wire validation for editable data, excluding identity and lifecycle. */
export const registryInputSchema = inputSchema.extend({
  resources: agentResourcesSchema.optional(),
  description: z.string().max(2000),
  ownerTeamId: z.string().min(1).max(100),
  harnessId: z.literal('deepseek-harness'),
  tags: z.array(z.string().trim().min(1).max(40)).max(20)
    .refine(tags => new Set(tags).size === tags.length, 'Duplicate tags'),
})

const recordSchema = registryInputSchema.extend({
  toolIds: z.array(z.string()),
  id: z.string().transform(value => brandString<RegistryAgentId>(value)),
  platformWorkspaceId: z.string(), lifecycle: z.enum(['active', 'archived']),
  revision: z.number().int().positive(), createdBy: z.string(), updatedBy: z.string(),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
  legacyPresetId: z.string().nullable(), creationFingerprint: z.string(),
})
type RecordValue = z.infer<typeof recordSchema>
const spec = defineDomain({
  name: 'platform_agent_registry', version: 1,
  tables: { agents: domainTable<RegistryAgentId, RecordValue>(recordSchema) },
})
const querySchema = z.strictObject({
  workspaceId: z.string(), query: z.string().max(200).optional(),
  lifecycle: z.enum(['active', 'archived', 'all']).default('active'),
  ownerTeamId: z.string().max(100).optional(), cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(24),
})

/** Structured failures projected by the API without disclosing foreign resources. */
export class RegistryError extends Error {
  constructor(readonly code: 'not-found' | 'conflict' | 'archived' | 'owner-invalid', message: string) { super(message) }
}

function publicRecord(record: RecordValue): RegistryAgent {
  const { creationFingerprint: _fingerprint, ...resource } = record
  return structuredClone(resource)
}

/** Single-writer Registry over the existing durable Domain queue. */
export class AgentRegistry {
  private creationQueue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly operations = new Map<string, Promise<unknown>>()
  private constructor(private readonly domain: Domain<typeof spec>, readonly workspace: RegistryWorkspace,
    private readonly workspaceLookup?: (id: string) => RegistryWorkspace) {}

  /** Open durable resource data; caller must close before releasing storage.
   * @param storage - mounted storage domain facility.
   * @param workspace - Host-owned organization scope.
   * @param workspaceLookup - optional governed workspace resolver.
   * @returns the single Registry owner.
   */
  static async open(storage: DomainFacility, workspace: RegistryWorkspace,
    workspaceLookup?: (id: string) => RegistryWorkspace): Promise<AgentRegistry> {
    return new AgentRegistry(await storage.open(spec), workspace, workspaceLookup)
  }

  /** Verify existing records against configured organizational workspaces.
   * @param validate - optional durable-reference validation.
   */
  validateOwnership(validate?: (agent: RegistryAgent) => void): void {
    for (const [, row] of this.domain.table('agents').entries()) { this.assertWorkspace(row.platformWorkspaceId); validate?.(publicRecord(row)) }
  }

  /** Drain creation and Domain writes during plugin disposal. */
  async close(): Promise<void> {
    this.closed = true
    await this.creationQueue
    await Promise.all(this.operations.values())
    await this.domain.close()
  }

  /** Serialize draft, archive, version and activation decisions on one Host.
   * @param workspaceId - organizational scope.
   * @param id - resource identity.
   * @param action - operation with exclusive access to this Agent.
   * @returns operation result after its durable commit.
   */
  exclusive<T>(workspaceId: string, id: string, action: () => Promise<T>): Promise<T> {
    this.get(workspaceId, id)
    const operation = (this.operations.get(id) ?? Promise.resolve()).then(action)
    const settled = operation.then(() => undefined, () => undefined)
    this.operations.set(id, settled)
    void settled.then(() => { if (this.operations.get(id) === settled) this.operations.delete(id) })
    return operation
  }

  private assertWorkspace(workspaceId: string): void {
    if (this.closed) throw new Error('Registry is closed')
    if (this.workspaceLookup !== undefined) { this.workspaceLookup(workspaceId); return }
    if (workspaceId !== this.workspace.id) throw new RegistryError('not-found', 'Workspace not found')
  }

  /** Read a resource including archived drafts.
   * @param workspaceId - organization scope, never a filesystem Workspace.
   * @param id - stable resource identity.
   * @returns a detached public record.
   */
  get(workspaceId: string, id: string): RegistryAgent {
    this.assertWorkspace(workspaceId)
    const record = this.domain.table('agents').get(brandString<RegistryAgentId>(id))
    if (record === undefined || record.platformWorkspaceId !== workspaceId) throw new RegistryError('not-found', 'Agent not found')
    return publicRecord(record)
  }

  /** List bounded summaries in stable ID order.
   * @param query - workspace, filters and keyset pagination.
   * @param visible - authorization filter applied before pagination.
   * @returns matching page without Prompt bodies.
   */
  list(query: RegistryQuery, visible?: (agent: RegistryAgent) => boolean): RegistryPage {
    const parsed = querySchema.parse(query)
    this.assertWorkspace(parsed.workspaceId)
    const search = parsed.query?.trim().toLocaleLowerCase() ?? ''
    const records = [...this.domain.table('agents').entries()].map(([, record]) => record)
      .filter(record => record.platformWorkspaceId === parsed.workspaceId
        && (visible === undefined || visible(publicRecord(record)))
        && (parsed.lifecycle === 'all' || record.lifecycle === parsed.lifecycle)
        && (parsed.ownerTeamId === undefined || record.ownerTeamId === parsed.ownerTeamId)
        && `${record.name} ${record.description} ${record.tags.join(' ')}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const remaining = records.filter(record => parsed.cursor === undefined || record.id > parsed.cursor)
    const page = remaining.slice(0, parsed.limit)
    return { total: records.length, nextCursor: remaining.length > page.length ? page.at(-1)?.id ?? null : null,
      items: page.map(record => ({ id: record.id, name: record.name, description: record.description,
        ownerTeamId: record.ownerTeamId, harnessId: record.harnessId, lifecycle: record.lifecycle,
        model: { ...record.model }, toolCount: record.toolIds.length, updatedAt: record.updatedAt })) }
  }

  /** Persist one resource atomically; retries compare the original creation payload.
   * @param workspaceId - configured organization scope.
   * @param input - restricted current configuration.
   * @param requestToken - stable retry token.
   * @param legacyPresetId - trusted import identity; never supplied by clients.
   * @param createdBy - Host-owned actor, explicitly migration during legacy import.
   * @returns the committed resource, possibly already edited after creation.
   */
  async create(
    workspaceId: string, input: RegistryAgentInput, requestToken: string, legacyPresetId: string | null = null,
    createdBy: string = platformActor(),
  ): Promise<RegistryAgent> {
    this.assertWorkspace(workspaceId)
    const value = registryInputSchema.parse(input)
    tokenSchema.parse(requestToken)
    if (value.ownerTeamId !== (this.workspaceLookup?.(workspaceId) ?? this.workspace).ownerTeamId) throw new RegistryError('owner-invalid', 'Owner is outside this workspace')
    const id = brandString<RegistryAgentId>(legacyPresetId ?? `resource-${createHash('sha256').update(`${workspaceId}:${createdBy}:${requestToken}`).digest('hex').slice(0, 32)}`)
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const operation = this.creationQueue.then(async () => {
      const previous = this.domain.table('agents').get(id)
      if (previous !== undefined) {
        if (previous.platformWorkspaceId !== workspaceId || previous.creationFingerprint !== fingerprint) {
          throw new RegistryError('conflict', 'Creation token already used for different input')
        }
        return publicRecord(previous)
      }
      const now = new Date().toISOString()
      const record: RecordValue = { ...value, id, platformWorkspaceId: workspaceId, lifecycle: 'active', revision: 1,
        createdBy, updatedBy: createdBy, createdAt: now, updatedAt: now, archivedAt: null,
        legacyPresetId, creationFingerprint: fingerprint }
      await this.domain.table('agents').put(id, record)
      return publicRecord(record)
    })
    this.creationQueue = operation.catch(() => undefined)
    return operation
  }

  /** Replace the current draft under an optimistic lock; history stays elsewhere.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @param expectedRevision - revision loaded by the editor.
   * @param input - complete replacement draft and metadata.
   * @returns committed resource with an incremented revision.
   */
  async update(workspaceId: string, id: string, expectedRevision: number, input: RegistryAgentInput): Promise<RegistryAgent> {
    this.get(workspaceId, id)
    const value = registryInputSchema.parse(input)
    z.number().int().positive().parse(expectedRevision)
    if (value.ownerTeamId !== (this.workspaceLookup?.(workspaceId) ?? this.workspace).ownerTeamId) throw new RegistryError('owner-invalid', 'Owner is outside this workspace')
    const record = await this.exclusive(workspaceId, id, () => this.domain.table('agents').update(brandString<RegistryAgentId>(id), (current) => {
      if (current.revision !== expectedRevision) throw new RegistryError('conflict', 'Agent changed; reload before saving')
      if (current.lifecycle === 'archived') throw new RegistryError('archived', 'Restore this Agent before editing')
      return { ...current, ...value, revision: current.revision + 1, updatedBy: platformActor(), updatedAt: new Date().toISOString() }
    }))
    return publicRecord(record)
  }

  /** Archive or restore without deleting executable assets or past Sessions.
   * @param workspaceId - organization scope.
   * @param id - resource identity.
   * @param expectedRevision - revision on which the action was based.
   * @param archived - requested lifecycle state.
   * @returns committed lifecycle, retaining all configuration.
   */
  async setArchived(workspaceId: string, id: string, expectedRevision: number, archived: boolean): Promise<RegistryAgent> {
    this.get(workspaceId, id)
    z.number().int().positive().parse(expectedRevision)
    z.boolean().parse(archived)
    const lifecycle = archived ? 'archived' : 'active'
    const record = await this.exclusive(workspaceId, id, () => this.domain.table('agents').update(brandString<RegistryAgentId>(id), (current) => {
      if (current.lifecycle === lifecycle) return current
      if (current.revision !== expectedRevision) throw new RegistryError('conflict', 'Agent changed; reload before saving')
      const now = new Date().toISOString()
      return { ...current, lifecycle, archivedAt: archived ? now : null,
        revision: current.revision + 1, updatedBy: platformActor(), updatedAt: now }
    }))
    return publicRecord(record)
  }
}
