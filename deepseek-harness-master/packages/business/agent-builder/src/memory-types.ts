/** Persistent Memory Platform scope and namespace records. */

/** Scopes supported by the first platform-owned MemoryStore release. */
export type MemoryScope = 'session' | 'user' | 'agent'

/** Trusted runtime identities needed to resolve a scoped MemoryStore namespace. */
export interface MemoryContext {
  workspaceId: string
  agentId: string
  userId: string | null
  conversationId: string
}

/** One fully resolved namespace; callers cannot substitute a different subject after resolution. */
export interface MemoryNamespace {
  workspaceId: string
  memoryStoreId: string
  scope: MemoryScope
  subjectId: string
}

/** Immutable MemoryStore policy captured by an Agent Version. */
export interface MemoryBindingPolicy {
  readScopes: MemoryScope[]
  writeScopes: MemoryScope[]
  retrieval: { enabled: boolean; topK: number; minScore: number }
  extraction: { sessionSummary: boolean; semanticFact: boolean }
}
