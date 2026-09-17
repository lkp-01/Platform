/** Platform resource namespaces, independent of directory Workspaces and user authentication. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RegistryError } from './registry.ts'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const roleSchema = z.enum(['admin', 'developer', 'user'])
/** Persisted membership retained when the namespace directory is used without login. */
export const memberSchema = z.object({ userId: id, role: roleSchema, revision: z.number().int().positive(), joinedAt: z.string() })
/** Control-plane audit facts; execution facts remain in Run and Trace. */
export const auditSchema = z.object({ id: z.string(), actorId: z.string(), action: z.string(), targetId: z.string(),
  occurredAt: z.string() })
/** Existing governance records with additive namespace-only creation metadata. */
export const workspaceSchema = z.object({ id, name: z.string(), status: z.enum(['active', 'archived']),
  revision: z.number().int().positive(),
  creationFingerprint: z.string().optional(), namespaceOnly: z.boolean().optional(),
  createdAt: z.string(), updatedAt: z.string(), members: z.array(memberSchema),
  memberRevisions: z.record(z.string(), z.number().int().nonnegative()).default({}), audit: z.array(auditSchema) })
/** One durable authority shared by the namespace directory and optional Governance. */
export const workspaceDomain = defineDomain({ name: 'platform_governance', version: 1, tables: {
  workspaces: domainTable(workspaceSchema),
  sessions: domainTable(z.object({ userId: id, tokenHash: z.string(), credentialHash: z.string(), expiresAt: z.number() })),
} })

/** Stable business-space identity; never a filesystem WorkspaceId. */
export type PlatformWorkspaceId = string & Branded<'PlatformWorkspaceId'>
/** Public namespace metadata, without membership or session secrets. */
export interface PlatformWorkspace {
  id: PlatformWorkspaceId
  name: string
  createdAt: string
  updatedAt: string
  status: 'active' | 'archived'
  revision: number
}
/** One owner of the existing governance Domain shared with optional authorization. */
export class PlatformWorkspaces {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private constructor(readonly domain: Domain<typeof workspaceDomain>) {}
  /** Open the existing namespace records without creating users.
   * @param storage - platform persistence.
   * @returns single domain owner.
   */
  static async open(storage: DomainFacility): Promise<PlatformWorkspaces> {
    return new PlatformWorkspaces(await storage.open(workspaceDomain))
  }
  /** Drain namespace writes and release the domain. */
  async close(): Promise<void> { this.closed = true; await this.tail; await this.domain.close() }
  /** Resolve public metadata for a known namespace.
   * @param workspaceId - stable business-space ID.
   * @returns detached metadata.
   */
  get(workspaceId: string): PlatformWorkspace {
    const row = this.domain.table('workspaces').get(workspaceId)
    if (row === undefined) throw new RegistryError('not-found', 'Workspace not found')
    return { id: brandString<PlatformWorkspaceId>(row.id), name: row.name, createdAt: row.createdAt,
      updatedAt: row.updatedAt, status: row.status, revision: row.revision }
  }
  /** List namespaces for a trusted local Demo; governed callers use membership filtering.
   * @returns public workspace metadata.
   */
  list(): PlatformWorkspace[] { return [...this.domain.table('workspaces').entries()].map(([key]) => this.get(key)) }
  /** Preserve an explicitly configured legacy namespace when enabling the local Demo.
   * @param workspaceId - original Host namespace.
   * @param name - original display name.
   */
  async ensureLegacy(workspaceId: string, name: string): Promise<void> {
    id.parse(workspaceId)
    if (this.domain.table('workspaces').get(workspaceId) !== undefined) return
    const now = new Date().toISOString()
    await this.domain.table('workspaces').put(workspaceId, { id: workspaceId, name, createdAt: now, updatedAt: now,
      status: 'active', revision: 1, members: [], memberRevisions: {}, audit: [], namespaceOnly: true })
  }
  /** Create a namespace without an identity or role; later governed activation requires an administrator.
   * @param name - display name.
   * @param token - durable retry UUID.
   * @returns the newly persisted or previously created namespace.
   */
  create(name: string, token: string): Promise<PlatformWorkspace> {
    const label = z.string().trim().min(1).max(100).parse(name)
    const key = `workspace-${createHash('sha256').update(z.uuid().parse(token)).digest('hex').slice(0, 32)}`
    if (this.closed) return Promise.reject(new Error('Workspace directory is closed'))
    const work = this.tail.then(async () => {
      const previous = this.domain.table('workspaces').get(key)
      if (previous !== undefined) {
        if (previous.creationFingerprint !== label) throw new RegistryError('conflict', 'Workspace token was reused with different input')
        return this.get(key)
      }
      const now = new Date().toISOString()
      await this.domain.table('workspaces').put(key, { id: key, name: label, createdAt: now, updatedAt: now,
        status: 'active', revision: 1, members: [], memberRevisions: {}, audit: [], namespaceOnly: true, creationFingerprint: label })
      return this.get(key)
    })
    this.tail = work.catch(() => undefined)
    return work
  }
}
