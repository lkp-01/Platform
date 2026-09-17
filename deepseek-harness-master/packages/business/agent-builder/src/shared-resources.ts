import { platformActor } from './principal-context.ts'
/** Single-Host resource lifecycle, independent of Agent drafts and execution. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { TOOL_CHOICES, tokenSchema } from './definition.ts'
import { RegistryError } from './registry.ts'
import { agentResourcesSchema, resourceHash, resourceInputSchema, resourceRecordSchema, resourceStatusSchema } from './resource-schema.ts'
import type { AgentResources, ResourceBinding, ResourceInput, ResourceManifest, ResourceRef, ResourceStatus, ResourceVersion,
  SharedResource, SharedResourceId, SharedResourceVersionId } from './resource-types.ts'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

type Row = z.infer<typeof resourceRecordSchema>
const domainSpec = defineDomain({ name: 'platform_shared_resources', version: 1,
  tables: { resources: domainTable<string, Row>(resourceRecordSchema) } })
function digest(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function publicRow(row: Row): SharedResource {
  const { creationFingerprint: _fingerprint, receipts: _receipts, ...value } = row
  return structuredClone(value)
}

/** Durable resource directory with serialized publication and optimistic draft edits. */
export class SharedResources {
  private constructor(private readonly domain: Domain<typeof domainSpec>, readonly workspaceId: string,
    private readonly state = { queue: Promise.resolve() as Promise<unknown>, closed: false, seeding: Promise.resolve() }) {}
  /** Bind the same single-writer store to an explicit workspace.
   * @param workspaceId - trusted organizational scope.
   * @returns lightweight scoped reader/writer; the root owner closes storage.
   */
  forWorkspace(workspaceId: string): SharedResources { return new SharedResources(this.domain, workspaceId, this.state) }
  /** Open the resource directory.
   * @param storage - existing platform storage facility.
   * @param workspaceId - configured demo workspace.
   * @returns resource owner.
   */
  static async open(storage: DomainFacility, workspaceId: string): Promise<SharedResources> {
    return new SharedResources(await storage.open(domainSpec), workspaceId)
  }
  /** Verify existing resource ownership before exposing a governed deployment.
   * @param validate - rejects unknown workspace identities.
   */
  validateOwnership(validate: (workspaceId: string) => void): void {
    for (const [, row] of this.domain.table('resources').entries()) {
      validate(row.workspaceId)
      for (const version of row.versions) if (version.resourceId !== row.id) throw new Error('Resource version ownership mismatch')
    }
  }

  /** Validate durable bindings without rejecting disabled historical resources.
   * @param input - exact published references owned by this workspace.
   */
  validateReferences(input: AgentResources): void {
    for (const ref of [input.model, ...input.tools, ...input.skills]) {
      const row = this.row(ref.resourceId)
      if (!row.versions.some(version => version.id === ref.versionId && version.resourceId === row.id)) {
        throw new Error('Resource binding references missing version')
      }
    }
  }

  /** Drain writes before releasing storage. */
  async close(): Promise<void> { await this.state.seeding; this.state.closed = true; await this.state.queue; await this.domain.close() }
  private write<T>(action: () => Promise<T>): Promise<T> {
    if (this.state.closed) return Promise.reject(new Error('Resource registry is closed'))
    const result = this.state.queue.then(action)
    this.state.queue = result.catch(() => undefined)
    return result
  }
  private row(id: string): Row {
    const row = this.domain.table('resources').get(id)
    if (row === undefined || row.workspaceId !== this.workspaceId) throw new RegistryError('not-found', 'Shared resource not found')
    return row
  }
  /** List resources, including disabled records for management and history.
   * @returns detached resource records.
   */
  list(): SharedResource[] { return [...this.domain.table('resources').entries()].filter(([, row]) => row.workspaceId === this.workspaceId).map(([, row]) => publicRow(row)).sort((a,
    b) => a.name.localeCompare(b.name)) }
  /** Read a resource and all published versions.
   * @param id - stable resource identity.
   * @returns detached record.
   */
  get(id: string): SharedResource { return publicRow(this.row(id)) }
  private validate(input: ResourceInput): ResourceInput {
    const value = resourceInputSchema.parse(input)
    const selected = value.spec
    if (selected.kind === 'tool' && !TOOL_CHOICES.some(tool => tool.id === selected.operation)) {
      throw new RegistryError('conflict', 'Choose an installed tool operation')
    }
    return value
  }
  private async insert(input: ResourceInput, key: string): Promise<SharedResource> {
    const id = brandString<SharedResourceId>(`shared-${digest(`${this.workspaceId}:${key}`)}`)
    const fingerprint = JSON.stringify(input)
    return this.write(async () => {
      const previous = this.domain.table('resources').get(id)
      if (previous !== undefined) {
        if (previous.creationFingerprint !== fingerprint) throw new RegistryError('conflict',
          'Resource token already used for different input')
        return publicRow(previous)
      }
      if (this.list().some(row => row.name === input.name)) throw new RegistryError('conflict', 'Resource name already exists')
      const now = new Date().toISOString()
      const row: Row = { ...input, id, workspaceId: this.workspaceId, status: 'active', revision: 1, versions: [],
        createdAt: now, updatedAt: now, createdBy: platformActor(), updatedBy: platformActor(),
        creationFingerprint: fingerprint, receipts: {} }
      await this.domain.table('resources').put(id, row)
      return publicRow(row)
    })
  }
  /** Register a resource draft without publishing it.
   * @param input - metadata and typed adapter configuration.
   * @param token - retry UUID.
   * @returns committed draft.
   */
  create(input: ResourceInput,
    token: string): Promise<SharedResource> { tokenSchema.parse(token); return this.insert(this.validate(input), platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`) }
  /** Replace metadata and the next-version draft; published versions stay unchanged.
   * @param id - resource identity.
   * @param revision - loaded edit revision.
   * @param input - replacement draft.
   * @returns committed record.
   */
  update(id: string, revision: number, input: ResourceInput): Promise<SharedResource> {
    const value = this.validate(input)
    return this.write(async () => {
      const row = this.row(id)
      if (row.revision !== revision) throw new RegistryError('conflict', 'Resource changed; reload before saving')
      if (row.spec.kind !== value.spec.kind) throw new RegistryError('conflict', 'Resource kind cannot change')
      if (this.list().some(other => other.id !== id && other.name === value.name)) throw new RegistryError('conflict',
        'Resource name already exists')
      const next = { ...row, ...value, revision: row.revision + 1, updatedAt: new Date().toISOString(), updatedBy: platformActor() }
      await this.domain.table('resources').put(id, next)
      return publicRow(next)
    })
  }
  /** Publish the loaded draft once; a retry returns the same immutable version.
   * @param id - resource identity.
   * @param revision - expected draft revision.
   * @param token - retry UUID.
   * @returns published version.
   */
  publish(id: string, revision: number, token: string): Promise<ResourceVersion> {
    tokenSchema.parse(token)
    return this.write(async () => {
      const row = this.row(id)
      const receipt = row.receipts[platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`]
      if (receipt !== undefined) {
        if (receipt.fingerprint !== String(revision)) throw new RegistryError('conflict', 'Publication token already used')
        const published = row.versions.find(version => version.id === receipt.versionId)
        if (published === undefined) throw new RegistryError('conflict', 'Publication receipt has no version')
        return structuredClone(published)
      }
      if (row.revision !== revision) throw new RegistryError('conflict', 'Resource changed; reload before publishing')
      if (row.status !== 'active') throw new RegistryError('conflict', 'Activate the resource before publishing')
      const version: ResourceVersion = { id: brandString<SharedResourceVersionId>(`rv-${digest(`${id}:${platformActor()}:${token}`)}`),
        resourceId: row.id, versionNumber: row.versions.length + 1, spec: row.spec, specHash: resourceHash(row.spec),
        createdAt: new Date().toISOString() }
      await this.domain.table('resources').put(id, { ...row, revision: row.revision + 1, updatedAt: version.createdAt, updatedBy: platformActor(),
        versions: [...row.versions, version], receipts: { ...row.receipts, [platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`]: { fingerprint: String(revision),
          versionId: version.id } } })
      return structuredClone(version)
    })
  }
  /** Change availability without deleting history.
   * @param id - resource identity.
   * @param revision - expected edit revision.
   * @param status - requested availability.
   * @returns committed record.
   */
  setStatus(id: string, revision: number, status: ResourceStatus): Promise<SharedResource> {
    resourceStatusSchema.parse(status)
    return this.write(async () => {
      const row = this.row(id)
      if (row.status === status) return publicRow(row)
      if (row.revision !== revision) throw new RegistryError('conflict', 'Resource changed; reload before changing status')
      const next = { ...row, status, revision: row.revision + 1, updatedAt: new Date().toISOString(), updatedBy: platformActor() }
      await this.domain.table('resources').put(id, next)
      return publicRow(next)
    })
  }
  private binding(ref: ResourceRef, kind: ResourceInput['spec']['kind'], existing: boolean): ResourceBinding {
    const row = this.row(ref.resourceId)
    if (row.status === 'disabled' || row.status === 'archived' || (!existing && row.status === 'deprecated')) {
      throw new RegistryError('conflict', `Resource ${row.name} is ${row.status}`)
    }
    const version = row.versions.find(value => value.id === ref.versionId)
    if (version === undefined || version.spec.kind !== kind) throw new RegistryError('conflict', 'Resource version missing or wrong kind')
    if (version.specHash !== resourceHash(version.spec)) throw new RegistryError('conflict', 'Resource integrity check failed')
    return { ...structuredClone(version), name: row.name }
  }
  /** Resolve exact versions; never substitutes a newer resource.
   * @param input - selected resource versions.
   * @param existing - allow deprecated dependencies already bound to an Agent.
   * @returns complete immutable execution inputs.
   */
  resolve(input: AgentResources, existing = false): ResourceManifest {
    const refs = agentResourcesSchema.parse(input)
    const result = { model: this.binding(refs.model, 'model', existing), tools: refs.tools.map(ref => this.binding(ref, 'tool', existing)),
      skills: refs.skills.map(ref => this.binding(ref, 'skill', existing)) }
    const operations = result.tools.map(binding => binding.spec.kind === 'tool' ? binding.spec.operation : '')
    if (new Set(operations).size !== operations.length || new Set(refs.skills.map(ref => ref.resourceId)).size !== refs.skills.length) {
      throw new RegistryError('conflict', 'Duplicate tool operation or Skill')
    }
    return result
  }
  /** Recheck current lifecycle while retaining the saved execution inputs.
   * @param manifest - captured resource versions.
   */
  assertAvailable(manifest: ResourceManifest): void {
    const current = this.resolve({ model: { resourceId: manifest.model.resourceId, versionId: manifest.model.id },
      tools: manifest.tools.map(row => ({ resourceId: row.resourceId, versionId: row.id })),
      skills: manifest.skills.map(row => ({ resourceId: row.resourceId, versionId: row.id })) }, true)
    for (const [index, binding] of [current.model, ...current.tools, ...current.skills].entries()) {
      const captured = [manifest.model, ...manifest.tools, ...manifest.skills][index]
      if (captured === undefined) throw new RegistryError('conflict', 'Resource manifest incomplete')
      if (captured.specHash !== binding.specHash || resourceHash(captured.spec) !== captured.specHash) throw new RegistryError('conflict',
        'Resource manifest integrity check failed')
    }
  }
  /** Import installed capabilities once; later administrator edits are preserved.
   * @param models - Host model catalog, containing no secrets.
   * @param ownerTeamId - display ownership for seeded resources.
   */
  seed(models: ModelCatalog, ownerTeamId: string): Promise<void> {
    const operation = this.state.seeding.then(() => this.seedInstalled(models, ownerTeamId))
    this.state.seeding = operation.catch(() => undefined)
    return operation
  }
  private async seedInstalled(models: ModelCatalog, ownerTeamId: string): Promise<void> {
    const inputs: ResourceInput[] = [
      ...TOOL_CHOICES.map(tool => ({ name: tool.id, description: tool.description, ownerTeamId,
        spec: { kind: 'tool' as const, operation: tool.id } })),
      ...models.groups.flatMap(group => group.models.map(model => ({ name: `${group.id} / ${model.id}`, description: model.name,
        ownerTeamId, spec: { kind: 'model' as const, provider: group.id, model: model.id } }))),
    ]
    for (const input of inputs) {
      const key = `seed:${input.spec.kind}:${input.name}`
      const id = `shared-${digest(`${this.workspaceId}:${key}`)}`
      const existing = this.domain.table('resources').get(id)
      if (existing !== undefined && (existing.versions.length > 0 || existing.revision !== 1 || existing.status !== 'active')) continue
      const row = existing === undefined ? await this.insert(this.validate(input), key) : publicRow(existing)
      await this.publish(row.id, row.revision, '00000000-0000-4000-8000-000000000001')
    }
  }
  /** Translate a legacy editable configuration to the original imported versions.
   * @param model - legacy model selection.
   * @param tools - legacy operation names.
   * @returns exact references, or undefined when the old model is unavailable.
   */
  legacyRefs(model: ModelSelection, tools: string[]): AgentResources | undefined {
    const all = this.list()
    const find = (matches: (spec: ResourceInput['spec']) => boolean): ResourceRef | undefined => {
      const row = all.find(value => value.versions[0] !== undefined && matches(value.versions[0].spec))
      const version = row?.versions[0]
      return row === undefined || version === undefined ? undefined : { resourceId: row.id, versionId: version.id }
    }
    const selected = find(spec => spec.kind === 'model' && spec.provider === model.provider && spec.model === model.model)
    const refs = tools.map(operation => find(spec => spec.kind === 'tool' && spec.operation === operation))
    if (selected === undefined || refs.some(ref => ref === undefined)) return undefined
    return { model: selected, tools: refs.filter((ref): ref is ResourceRef => ref !== undefined), skills: [] }
  }
}
