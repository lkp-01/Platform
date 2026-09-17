/** Provider-independent semantic Memory search interface. */
import type { MemoryItem } from './memory-store.ts'
import type { MemoryNamespace } from './memory-types.ts'

/** One ranked Memory Item result after authorization and vector filtering. */
export interface MemorySearchResult {
  item: MemoryItem
  score: number
}

/** Semantic retrieval capability; callers supply an already-authorized namespace. */
export interface MemoryProvider {
  search(input: {
    namespace: MemoryNamespace
    model: string
    vector: readonly number[]
    topK: number
    minScore: number
    signal: AbortSignal
  }): Promise<MemorySearchResult[]>
}
