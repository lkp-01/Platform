/** Validation and trusted namespace resolution for durable MemoryStore data. */
import { z } from 'zod'
import type { MemoryContext, MemoryNamespace, MemoryScope } from './memory-types.ts'

const identity = z.string().trim().min(1).max(200)

/** Valid Memory Platform ownership scopes. */
export const memoryScopeSchema = z.enum(['session', 'user', 'agent'])

/** A resolved MemoryStore namespace with exactly one authorized subject. */
export const memoryNamespaceSchema = z.strictObject({
  workspaceId: identity,
  memoryStoreId: identity,
  scope: memoryScopeSchema,
  subjectId: identity,
})

/** Runtime identity persisted with a Run before any Memory operation begins. */
export const memoryContextSchema = z.strictObject({
  workspaceId: identity,
  agentId: identity,
  userId: identity.nullable(),
  conversationId: identity,
})

/** Resolve a scope only from trusted Runtime identity.
 * @param memoryStoreId - bound MemoryStore identity.
 * @param scope - scope declared by the immutable Agent Version binding.
 * @param context - Run identity persisted by the Platform.
 * @returns fully qualified namespace used by storage and retrieval.
 */
export function resolveMemoryNamespace(memoryStoreId: string, scope: MemoryScope, context: MemoryContext): MemoryNamespace {
  const resolved = memoryContextSchema.parse(context)
  const subjectId = scope === 'session' ? resolved.conversationId
    : scope === 'agent' ? resolved.agentId
      : resolved.userId
  if (subjectId === null) throw new Error('User Memory requires an authenticated user identity')
  return memoryNamespaceSchema.parse({ workspaceId: resolved.workspaceId, memoryStoreId, scope, subjectId })
}

/** Stable, opaque storage key for one already-authorized Memory namespace.
 * @param namespace - validated namespace.
 * @returns deterministic serialized key with unambiguous component boundaries.
 */
export function memoryNamespaceKey(namespace: MemoryNamespace): string {
  const value = memoryNamespaceSchema.parse(namespace)
  return JSON.stringify([value.workspaceId, value.memoryStoreId, value.scope, value.subjectId])
}
