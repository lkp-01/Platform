/** Durable business conversation ownership; Harness execution Sessions remain Run-local. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RegistryError } from './registry.ts'

const identity = z.string().trim().min(1).max(200)
const conversationSchema = z.strictObject({
  id: z.string().regex(/^conversation-[a-f0-9]{32}$/), workspaceId: identity, ownerUserId: identity,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), status: z.enum(['active', 'archived']),
  creationFingerprint: z.string(),
})
const spec = defineDomain({ name: 'platform_conversations', version: 1, tables: { conversations: domainTable(conversationSchema) } })

/** Business conversation identity used as the session Memory scope subject. */
export type PlatformConversation = z.infer<typeof conversationSchema>

/** Single-Host owner of durable business conversations. */
export class PlatformConversations {
  private constructor(private readonly domain: Domain<typeof spec>) {}
  /** Open the business conversation directory.
   * @param storage - Platform persistence facility.
   * @returns durable conversation authority.
   */
  static async open(storage: DomainFacility): Promise<PlatformConversations> {
    return new PlatformConversations(await storage.open(spec))
  }
  /** Close durable storage after all callers stop.
   * @returns completion once the domain is closed.
   */
  async close(): Promise<void> { await this.domain.close() }
  /** Resolve an existing conversation only for its owner and Workspace.
   * @param workspaceId - requested Platform Workspace.
   * @param ownerUserId - authenticated business user.
   * @param conversationId - opaque conversation identity.
   * @returns verified active conversation.
   */
  get(workspaceId: string, ownerUserId: string, conversationId: string): PlatformConversation {
    const row = this.domain.table('conversations').get(z.string().parse(conversationId))
    if (row === undefined || row.workspaceId !== identity.parse(workspaceId) || row.ownerUserId !== identity.parse(ownerUserId)) {
      throw new RegistryError('not-found', 'Conversation not found')
    }
    if (row.status !== 'active') throw new RegistryError('archived', 'Conversation is archived')
    return structuredClone(row)
  }
  /** Create an owner-scoped conversation exactly once for an admission token.
   * @param workspaceId - requested Platform Workspace.
   * @param ownerUserId - authenticated business user.
   * @param token - idempotency token from the Run admission.
   * @returns newly created or prior matching conversation.
   */
  async create(workspaceId: string, ownerUserId: string, token: string): Promise<PlatformConversation> {
    const workspace = identity.parse(workspaceId)
    const owner = identity.parse(ownerUserId)
    const admissionToken = z.uuid().parse(token)
    const fingerprint = JSON.stringify([workspace, owner])
    const id = `conversation-${createHash('sha256').update(JSON.stringify([workspace, owner, admissionToken])).digest('hex').slice(0, 32)}`
    const prior = this.domain.table('conversations').get(id)
    if (prior !== undefined) {
      if (prior.creationFingerprint !== fingerprint) throw new RegistryError('conflict', 'Conversation token was reused with a different identity')
      return structuredClone(prior)
    }
    const now = new Date().toISOString()
    const row = conversationSchema.parse({ id, workspaceId: workspace, ownerUserId: owner, createdAt: now, updatedAt: now,
      status: 'active', creationFingerprint: fingerprint })
    await this.domain.table('conversations').put(id, row)
    return structuredClone(row)
  }
  /** Resolve an existing conversation or create an owner-scoped conversation.
   * @param workspaceId - requested Platform Workspace.
   * @param ownerUserId - authenticated business user.
   * @param requestedId - client-selected existing conversation, if any.
   * @param token - idempotency token used for creation only.
   * @returns verified active conversation.
   */
  getOrCreate(workspaceId: string, ownerUserId: string, requestedId: string | undefined, token: string): Promise<PlatformConversation> {
    return requestedId === undefined ? this.create(workspaceId, ownerUserId, token) : Promise.resolve(this.get(workspaceId, ownerUserId, requestedId))
  }
}
