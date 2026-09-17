import { platformActor } from './principal-context.ts'
/** Single-writer immutable versions with atomic sequence and retry receipts. */
import type { ResourceManifest } from './resource-types.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { tokenSchema } from './definition.ts'
import { RegistryError, type AgentRegistry } from './registry.ts'
import { captureSnapshot, snapshotHash, versionSchema } from './version-schema.ts'
import type { AgentHistoryPage, AgentVersion, AgentVersionId, AgentVersionSummary, RegistryAgent } from './types.ts'

const spec = defineDomain({ name: 'platform_agent_versions', version: 1, tables: {
  agents: domainTable<string, { versions: AgentVersion[]; receipts: Record<string, { fingerprint: string; versionId: AgentVersionId }> }>(
    z.object({ versions: z.array(versionSchema), receipts: z.record(z.string(), z.object({ fingerprint: z.string(),
      versionId: z.string().transform(value => brandString<AgentVersionId>(value)) })) })),
} })

/** Paginate newest-first histories using a validated offset.
 * @param items - already ordered history.
 * @param cursor - offset, zero for the first page.
 * @returns bounded page.
 */
export function historyPage<T>(items: T[], cursor: number): AgentHistoryPage<T> {
  z.number().int().nonnegative().parse(cursor)
  return { items: items.slice(cursor, cursor + 24), nextCursor: cursor + 24 < items.length ? cursor + 24 : null }
}

/** Version use cases serialize with draft edits and archival through Registry. */
export class AgentVersions {
  private constructor(private readonly domain: Domain<typeof spec>, private readonly registry: AgentRegistry) {}
  /** Open version persistence.
   * @param storage - deployed storage backend.
   * @param registry - resource authority and per-Agent serialization.
   * @returns opened version owner.
   */
  static async open(storage: DomainFacility, registry: AgentRegistry): Promise<AgentVersions> {
    return new AgentVersions(await storage.open(spec), registry)
  }
  /** Verify every immutable version references its owning Agent workspace.
   * @param validate - optional durable-resource validation.
   */
  validateOwnership(validate?: (version: AgentVersion) => void): void {
    for (const [agentId, row] of this.domain.table('agents').entries()) for (const version of row.versions) {
      if (version.agentId !== agentId) throw new Error('Version Agent ownership mismatch')
      this.registry.get(version.platformWorkspaceId, version.agentId)
      validate?.(version)
    }
  }

  /** Drain persistent writes. */
  async close(): Promise<void> { await this.domain.close() }
  /** Resolve an internal Preset reference without consulting a mutable draft.
   * @param versionId - composition identity.
   * @returns saved version or undefined for ordinary Presets.
   */
  find(versionId: string): AgentVersion | undefined {
    for (const [, record] of this.domain.table('agents').entries()) {
      const found = record.versions.find(version => version.id === versionId)
      if (found !== undefined) return structuredClone(found)
    }
    return undefined
  }
  /** Read one historical snapshot regardless of dependency availability.
   * @param workspace - organizational scope.
   * @param agentId - resource identity.
   * @param versionId - immutable version identity.
   * @returns detached saved version.
   */
  get(workspace: string, agentId: string, versionId: string): AgentVersion {
    this.registry.get(workspace, agentId)
    const version = this.domain.table('agents').get(agentId)?.versions.find(value => value.id === versionId)
    if (version === undefined || version.platformWorkspaceId !== workspace || version.agentId !== agentId) throw new RegistryError('not-found', 'Version not found')
    return structuredClone(version)
  }
  /** List bounded version metadata newest first.
   * @param workspace - organizational scope.
   * @param agentId - resource identity.
   * @param cursor - page offset.
   * @returns summary page without Prompt bodies.
   */
  list(workspace: string, agentId: string, cursor: number): AgentHistoryPage<AgentVersionSummary> {
    this.registry.get(workspace, agentId)
    const rows = [...(this.domain.table('agents').get(agentId)?.versions ?? [])].reverse().map(({ snapshot, ...version }) =>
      ({ ...version, model: { ...snapshot.model }, toolCount: snapshot.toolIds.length }))
    return structuredClone(historyPage(rows, cursor))
  }
  /** Save exactly one Registry revision; request retries retain their first result.
   * @param workspace - organizational scope.
   * @param agentId - resource identity.
   * @param revision - expected saved draft revision.
   * @param token - stable submission UUID.
   * @param note - optional human change description.
   * @param validate - current execution dependency validation, without model calls.
   * @param resolveResources - optional resolver for exact draft dependencies.
   * @returns committed immutable version.
   */
  async create(workspace: string, agentId: string, revision: number, token: string, note: string,
    validate: (draft: RegistryAgent) => Promise<LlmCallConfig | void>,
    resolveResources?: (draft: RegistryAgent) => ResourceManifest | undefined): Promise<AgentVersion> {
    tokenSchema.parse(token); z.number().int().positive().parse(revision); z.string().max(2000).parse(note)
    return this.registry.exclusive(workspace, agentId, async () => {
      const table = this.domain.table('agents')
      const fingerprint = JSON.stringify([revision, note])
      const previous = table.get(agentId)
      const receipt = previous?.receipts[platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`]
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) throw new RegistryError('conflict',
          'Version request token already used for different input')
        return this.get(workspace, agentId, receipt.versionId)
      }
      const draft = this.registry.get(workspace, agentId)
      if (draft.lifecycle === 'archived') throw new RegistryError('archived', 'Restore this Agent before saving a version')
      if (draft.revision !== revision) throw new RegistryError('conflict', 'Draft changed; reload before saving a version')
      const resolved = await validate(draft)
      const snapshot = captureSnapshot(draft, resolved, resolveResources?.(draft))
      const id = brandString<AgentVersionId>(`version-${createHash('sha256').update(JSON.stringify([workspace, agentId, ...(platformActor() === 'shared-host' ? [] : [platformActor()]), token])).digest('hex').slice(0, 32)}`)
      const version: AgentVersion = { id, agentId: draft.id, platformWorkspaceId: workspace, sourceRevision: revision,
        versionNumber: (previous?.versions.length ?? 0) + 1, schemaVersion: snapshot.resources === undefined ? 1 : 2,
        snapshot, configHash: snapshotHash(snapshot),
        changeNote: note, createdAt: new Date().toISOString(), createdBy: platformActor() }
      await table.put(agentId, { versions: [...(previous?.versions ?? []), version],
        receipts: { ...previous?.receipts, [platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`]: { fingerprint, versionId: id } } })
      return structuredClone(version)
    })
  }
}
