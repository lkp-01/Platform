import { platformActor } from './principal-context.ts'
/** Default-target activation with atomic pointer, history and retry receipts. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { tokenSchema } from './definition.ts'
import { RegistryError, type AgentRegistry } from './registry.ts'
import { historyPage, type AgentVersions } from './versions.ts'
import type { AgentDeployment, AgentHistoryPage, AgentVersion, AgentVersionId, RegistryAgentId } from './types.ts'

const deploymentSchema = z.object({
  agentId: z.string().transform(value => brandString<RegistryAgentId>(value)), platformWorkspaceId: z.string(), target: z.literal('default'),
  versionId: z.string().transform(value => brandString<AgentVersionId>(value)),
  previousVersionId: z.string().transform(value => brandString<AgentVersionId>(value)).nullable(),
  revision: z.number().int().positive(), action: z.enum(['deploy', 'rollback']), updatedBy: z.string(), updatedAt: z.iso.datetime(),
})
const spec = defineDomain({ name: 'platform_agent_deployments', version: 1, tables: {
  agents: domainTable<string, { history: AgentDeployment[]; receipts: Record<string, { fingerprint: string; revision: number }> }>(
    z.object({ history: z.array(deploymentSchema),
      receipts: z.record(z.string(), z.object({ fingerprint: z.string(), revision: z.number().int().positive() })) })),
} })

/** Deployment owner; version creation never changes its pointer. */
export class AgentDeployments {
  private constructor(
    private readonly domain: Domain<typeof spec>, private readonly registry: AgentRegistry, private readonly versions: AgentVersions,
  ) {}
  /** Open activation persistence.
   * @param storage - configured backend.
   * @param registry - resource authority.
   * @param versions - immutable version reader.
   * @returns deployment owner.
   */
  static async open(storage: DomainFacility, registry: AgentRegistry, versions: AgentVersions): Promise<AgentDeployments> {
    return new AgentDeployments(await storage.open(spec), registry, versions)
  }
  /** Verify historical activations retain their Agent and version workspace. */
  validateOwnership(): void {
    for (const [agentId, row] of this.domain.table('agents').entries()) for (const deployment of row.history) {
      if (deployment.agentId !== agentId) throw new Error('Deployment Agent ownership mismatch')
      this.versions.get(deployment.platformWorkspaceId, deployment.agentId, deployment.versionId)
    }
  }

  /** Drain persistent writes. */
  async close(): Promise<void> { await this.domain.close() }
  /** Read the current default activation.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @returns last activation or null before deployment.
   */
  get(workspace: string, agentId: string): AgentDeployment | null {
    this.registry.get(workspace, agentId)
    return structuredClone(this.domain.table('agents').get(agentId)?.history.at(-1) ?? null)
  }
  /** Read activation history newest first.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param cursor - page offset.
   * @returns bounded history.
   */
  history(workspace: string, agentId: string, cursor: number): AgentHistoryPage<AgentDeployment> {
    this.registry.get(workspace, agentId)
    return structuredClone(historyPage([...(this.domain.table('agents').get(agentId)?.history ?? [])].reverse(), cursor))
  }
  /** Prepare a target completely before switching the durable default pointer.
   * @param workspace - organization scope.
   * @param agentId - resource identity.
   * @param versionId - exact target version.
   * @param revision - expected deployment revision, zero before first activation.
   * @param token - retry identity.
   * @param action - activation intent recorded in history.
   * @param prepare - validate dependencies and materialize the immutable Preset.
   * @returns committed activation; retries return their original result.
   */
  async activate(workspace: string, agentId: string, versionId: string, revision: number, token: string,
    action: 'deploy' | 'rollback', prepare: (version: AgentVersion) => Promise<void>): Promise<AgentDeployment> {
    tokenSchema.parse(token); z.number().int().nonnegative().parse(revision); z.enum(['deploy', 'rollback']).parse(action)
    return this.registry.exclusive(workspace, agentId, async () => {
      const previous = this.domain.table('agents').get(agentId)
      const fingerprint = JSON.stringify([versionId, revision, action])
      const receiptKey = platformActor() === 'shared-host' ? token : `${platformActor()}:${token}`
      const receipt = previous?.receipts[receiptKey]
      if (previous !== undefined && receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) throw new RegistryError('conflict', 'Deployment request token already used for different input')
        const saved = previous.history[receipt.revision - 1]
        if (saved === undefined) throw new Error('Deployment receipt references missing history')
        return structuredClone(saved)
      }
      const agent = this.registry.get(workspace, agentId)
      if (agent.lifecycle === 'archived') throw new RegistryError('archived', 'Restore this Agent before deployment')
      const current = previous?.history.at(-1)
      if ((current?.revision ?? 0) !== revision) throw new RegistryError('conflict', 'Deployment changed; refresh before switching versions')
      const version = this.versions.get(workspace, agentId, versionId)
      if (action === 'rollback' && (current === undefined || version.versionNumber >= this.versions.get(workspace, agentId, current.versionId).versionNumber)) {
        throw new RegistryError('conflict', 'Rollback requires an older saved version')
      }
      await prepare(version)
      const deployment: AgentDeployment = { agentId: agent.id, platformWorkspaceId: workspace, target: 'default', versionId: version.id,
        previousVersionId: current?.versionId ?? null, revision: revision + 1, action,
        updatedBy: platformActor(), updatedAt: new Date().toISOString() }
      await this.domain.table('agents').put(agentId, { history: [...(previous?.history ?? []), deployment],
        receipts: { ...previous?.receipts, [receiptKey]: { fingerprint, revision: deployment.revision } } })
      return structuredClone(deployment)
    })
  }
}
