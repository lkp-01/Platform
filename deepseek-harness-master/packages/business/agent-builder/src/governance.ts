/** Workspace membership and fixed roles on a single durable writer. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { PlatformWorkspaces, memberSchema, workspaceSchema, auditSchema } from './platform-workspaces.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const roleSchema = z.enum(['admin', 'developer', 'user'])
/** Fixed workspace roles; users can hold a different role in each workspace. */
export type WorkspaceRole = z.infer<typeof roleSchema>
/** Read includes archived history; run/edit require an active workspace. */
export type WorkspaceAction = 'read' | 'run' | 'edit' | 'admin'
/** Host-provisioned identities contain credential digests, never plaintext credentials. */
export const governanceConfigSchema = z.strictObject({
  users: z.array(z.strictObject({ id, displayName: z.string().min(1).max(100), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    active: z.boolean().default(true) })).min(1).max(200),
  workspaces: z.array(z.strictObject({ id, name: z.string().min(1).max(100), adminId: id })).min(1).max(100),
  publicOrigin: z.url().optional(),
  sessionHours: z.number().int().min(1).max(168).default(8),
}).superRefine((value, ctx) => {
  if (value.publicOrigin !== undefined) {
    const origin = new URL(value.publicOrigin)
    if (origin.origin !== value.publicOrigin || (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost',
      '[::1]'].includes(origin.hostname))) {
      ctx.addIssue({ code: 'custom', message: 'Public origin must be an HTTPS origin, or HTTP loopback' })
    }
  }
  for (const rows of [value.users.map(row => row.id), value.users.map(row => row.tokenHash), value.workspaces.map(row => row.id)]) {
    if (new Set(rows).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate governance identity' })
  }
  if (value.users.some(row => ['shared-host', 'migration'].includes(row.id))) ctx.addIssue({ code: 'custom',
    message: 'Reserved historical identity' })
  for (const workspace of value.workspaces) if (!value.users.some(user => user.id === workspace.adminId && user.active)) {
    ctx.addIssue({ code: 'custom', message: 'Workspace requires an active bootstrap administrator' })
  }
})
type Workspace = z.infer<typeof workspaceSchema>
/** Workspace metadata returned with the current member's role. */
export type WorkspaceView = Omit<Workspace,
  'members' | 'memberRevisions' | 'audit' | 'creationFingerprint' | 'namespaceOnly'> & { role: WorkspaceRole }

/** Authorization failures expose no foreign resource metadata. */
export class GovernanceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) { super(message) }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Durable membership authority; bootstrap never re-adds removed members. */
export class Governance {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private constructor(readonly workspaces: PlatformWorkspaces, readonly config: z.infer<typeof governanceConfigSchema>) {}
  private get domain() { return this.workspaces.domain }

  /** Open governance and initialize only missing workspaces.
   * @param storage - platform storage facility.
   * @param input - trusted operator configuration, validated at load.
   * @returns opened authority; caller owns close.
   */
  static async open(storage: DomainFacility, input: unknown): Promise<Governance> {
    const config = governanceConfigSchema.parse(input)
    const owner = new Governance(await PlatformWorkspaces.open(storage), config)
    try {
      for (const workspace of config.workspaces) {
        const existing = owner.domain.table('workspaces').get(workspace.id)
        if (existing !== undefined) {
          if (existing.namespaceOnly && existing.members.length === 0) {
            await owner.domain.table('workspaces').put(workspace.id, { ...existing, namespaceOnly: false,
              memberRevisions: { [workspace.adminId]: 1 }, members: [{ userId: workspace.adminId, role: 'admin', revision: 1,
                joinedAt: new Date().toISOString() }] })
          }
          continue
        }
        const now = new Date().toISOString()
        await owner.domain.table('workspaces').put(workspace.id, { id: workspace.id, name: workspace.name, status: 'active',
          revision: 1, createdAt: now, updatedAt: now, memberRevisions: { [workspace.adminId]: 1 },
          members: [{ userId: workspace.adminId, role: 'admin', revision: 1, joinedAt: now }], audit: [] })
      }
      for (const [, workspace] of owner.domain.table('workspaces').entries()) {
        if (!workspace.members.some(member => member.role === 'admin' && config.users.some(user => user.id === member.userId && user.active))) {
          throw new Error(`Workspace ${workspace.id} has no active administrator`)
        }
      }
      return owner
    } catch (error) { await owner.close(); throw error }
  }

  /** Drain operations before closing persistence. */
  async close(): Promise<void> { this.closed = true; await this.tail; await this.workspaces.close() }

  private queue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Governance is closed'))
    const result = this.tail.then(action)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** Serialize a business mutation with member changes and authorize at execution.
   * @param actor - authenticated user identity.
   * @param workspace - target workspace.
   * @param action - fixed permission.
   * @param operation - authorized operation; must not recursively queue governance mutations.
   * @param auditAction - optional successful control-plane operation name.
   * @param auditTarget - known resource identity for operations without an ID result.
   * @returns committed business result.
   */
  perform<T>(actor: string, workspace: string, action: WorkspaceAction, operation: () => Promise<T>,
    auditAction?: string, auditTarget?: string): Promise<T> {
    return this.queue(async () => {
      this.authorize(actor, workspace, action)
      const result = await operation()
      if (auditAction !== undefined) {
        const row = this.row(workspace)
        const target = typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
          ? result.id : auditTarget ?? workspace
        await this.domain.table('workspaces').put(workspace, this.changed(row, actor, auditAction, target))
      }
      return result
    })
  }

  /** Verify current membership and workspace state without caching roles.
   * @param actor - authenticated user identity.
   * @param workspace - requested organizational scope.
   * @param action - required capability.
   * @returns current role.
   */
  authorize(actor: string, workspace: string, action: WorkspaceAction): WorkspaceRole {
    this.user(actor)
    const row = this.domain.table('workspaces').get(workspace)
    const member = row?.members.find(value => value.userId === actor)
    if (row === undefined || member === undefined) throw new GovernanceError(404, 'Resource not found')
    if (action === 'admin' && member.role !== 'admin' || action === 'edit' && member.role === 'user') {
      throw new GovernanceError(403, 'Permission denied')
    }
    if (row.status !== 'active' && action !== 'read' && action !== 'admin') throw new GovernanceError(403, 'Workspace is archived')
    return member.role
  }

  /** Return a provisioned active user without credential metadata.
   * @param actor - user identity.
   * @returns public user identity.
   */
  user(actor: string): { id: string; displayName: string } {
    const user = this.config.users.find(row => row.id === actor && row.active)
    if (user === undefined) throw new GovernanceError(401, 'Authentication required')
    return { id: user.id, displayName: user.displayName }
  }

  /** Internal workspace metadata lookup; membership must be checked by the caller.
   * @param workspace - stable identity.
   * @returns detached public metadata.
   */
  workspace(workspace: string): Omit<Workspace, 'members' | 'memberRevisions' | 'audit' | 'creationFingerprint' | 'namespaceOnly'> {
    const row = this.domain.table('workspaces').get(workspace)
    if (row === undefined) throw new GovernanceError(404, 'Resource not found')
    const { members: _members, memberRevisions: _revisions, audit: _audit, creationFingerprint: _fingerprint,
      namespaceOnly: _namespaceOnly, ...view } = row
    return structuredClone(view)
  }

  private row(workspace: string): Workspace {
    const row = this.domain.table('workspaces').get(workspace)
    if (row === undefined) throw new GovernanceError(404, 'Resource not found')
    return row
  }

  /** List only the caller's workspaces, including archived history.
   * @param actor - authenticated user.
   * @returns workspace metadata and current role.
   */
  list(actor: string): WorkspaceView[] {
    this.user(actor)
    return [...this.domain.table('workspaces').entries()].flatMap(([, row]) => {
      const member = row.members.find(value => value.userId === actor)
      return member === undefined ? [] : [{ ...this.workspace(row.id), role: member.role }]
    })
  }

  /** List current members for an administrator.
   * @param actor - caller.
   * @param workspace - authorized workspace.
   * @returns member revisions and display names.
   */
  members(actor: string, workspace: string): (z.infer<typeof memberSchema> & { displayName: string })[] {
    this.authorize(actor, workspace, 'admin')
    return this.row(workspace).members.map(member => ({ ...member,
      displayName: this.config.users.find(user => user.id === member.userId)?.displayName ?? member.userId }))
  }

  /** Add, change, or remove membership with atomic last-administrator protection.
   * @param actor - administrator.
   * @param workspace - target workspace.
   * @param userId - provisioned user.
   * @param role - desired role or null to remove.
   * @param revision - expected member revision, zero for a new member.
   */
  async setMember(actor: string, workspace: string, userId: string, role: WorkspaceRole | null, revision: number): Promise<void> {
    id.parse(userId); roleSchema.nullable().parse(role); z.number().int().nonnegative().parse(revision)
    await this.queue(async () => {
      this.authorize(actor, workspace, 'admin')
      if (role !== null) this.user(userId)
      const row = this.row(workspace)
      const current = row.members.find(member => member.userId === userId)
      if ((current?.revision ?? 0) !== revision) throw new GovernanceError(409, 'Member changed; reload')
      const nextRevision = (Object.hasOwn(row.memberRevisions, userId) ? row.memberRevisions[userId] ?? 0 : current?.revision ?? 0) + 1
      const members = row.members.filter(member => member.userId !== userId)
      if (role !== null) members.push({ userId, role, revision: nextRevision, joinedAt: current?.joinedAt ?? new Date().toISOString() })
      if (!members.some(member => member.role === 'admin' && this.config.users.some(user => user.id === member.userId && user.active))) {
        throw new GovernanceError(409, 'Keep at least one active administrator')
      }
      await this.domain.table('workspaces').put(workspace, this.changed({ ...row, members,
        memberRevisions: { ...row.memberRevisions, [userId]: nextRevision } }, actor, 'member:update', userId))
    })
  }

  /** Rename or archive a workspace without deleting its history.
   * @param actor - administrator.
   * @param workspace - target workspace.
   * @param revision - expected workspace revision.
   * @param name - display name.
   * @param status - desired availability.
   */
  async updateWorkspace(actor: string, workspace: string, revision: number, name: string, status: 'active' | 'archived'): Promise<void> {
    z.string().trim().min(1).max(100).parse(name); z.enum(['active', 'archived']).parse(status)
    await this.queue(async () => {
      this.authorize(actor, workspace, 'admin')
      const row = this.row(workspace)
      if (row.revision !== revision) throw new GovernanceError(409, 'Workspace changed; reload')
      await this.domain.table('workspaces').put(workspace, this.changed({ ...row, name, status, revision: revision + 1 }, actor,
        'workspace:update', workspace))
    })
  }

  private changed(row: Workspace, actorId: string, action: string, targetId: string): Workspace {
    const occurredAt = new Date().toISOString()
    return { ...row, updatedAt: occurredAt, audit: [...row.audit, { id: randomUUID(), actorId, action, targetId, occurredAt }] }
  }

  /** Read governance history without execution transcripts.
   * @param actor - administrator.
   * @param workspace - authorized workspace.
   * @returns most recent 100 changes, newest first.
   */
  audit(actor: string, workspace: string): z.infer<typeof auditSchema>[] {
    this.authorize(actor, workspace, 'admin')
    return structuredClone(this.row(workspace).audit.slice(-100).reverse())
  }

  /** Exchange an independently provisioned credential for a bounded browser session.
   * @param token - plaintext high-entropy credential, never persisted.
   * @returns fresh session token and absolute expiry.
   */
  login(token: string): Promise<{ token: string; expiresAt: number }> {
    const hash = Buffer.from(digest(token), 'hex')
    const user = this.config.users.find(row => row.active && timingSafeEqual(hash, Buffer.from(row.tokenHash, 'hex')))
    if (user === undefined) throw new GovernanceError(401, 'Invalid credential')
    return this.queue(async () => {
      for (const [key, session] of this.domain.table('sessions').entries()) {
        if (session.expiresAt <= Date.now() || session.userId === user.id) await this.domain.table('sessions').delete(key)
      }
      const sessionToken = randomBytes(32).toString('base64url')
      const expiresAt = Date.now() + this.config.sessionHours * 3600000
      const tokenHash = digest(sessionToken)
      await this.domain.table('sessions').put(tokenHash, { userId: user.id, tokenHash, credentialHash: user.tokenHash, expiresAt })
      return { token: sessionToken, expiresAt }
    })
  }

  /** Resolve an unexpired session against current operator-provisioned user state.
   * @param token - browser session credential.
   * @param now - current time in milliseconds.
   * @returns active user ID, or undefined for invalid credentials.
   */
  authenticate(token: string, now = Date.now()): string | undefined {
    const session = this.domain.table('sessions').get(digest(token))
    return session !== undefined && session.expiresAt > now
      && this.config.users.some(user => user.id === session.userId && user.active && user.tokenHash === session.credentialHash)
      ? session.userId : undefined
  }

  /** Revoke a browser session.
   * @param token - session credential.
   */
  async logout(token: string): Promise<void> { await this.queue(async () => { await this.domain.table('sessions').delete(digest(token)) }) }
}
