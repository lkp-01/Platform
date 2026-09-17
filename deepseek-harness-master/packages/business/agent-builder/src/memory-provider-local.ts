/** Bounded exact cosine search over locally persisted Memory Item embeddings. */
import { z } from 'zod'
import type { PlatformMemory } from './memory-store.ts'
import type { MemoryProvider, MemorySearchResult } from './memory-provider.ts'

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftMagnitude += a * a
    rightMagnitude += b * b
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

/** First provider implementation; it never enumerates a namespace the caller did not resolve. */
export class LocalMemoryProvider implements MemoryProvider {
  /** Create a provider over Platform-owned Memory Item storage.
   * @param memory - item store with namespace filtering.
   */
  constructor(private readonly memory: PlatformMemory) {}
  /** Retrieve the best matching active items from one namespace.
   * @param input - authorized namespace and validated query vector.
   * @returns deterministically ranked candidate items.
   */
  async search(input: Parameters<MemoryProvider['search']>[0]): Promise<MemorySearchResult[]> {
    input.signal.throwIfAborted()
    const vector = z.array(z.number().finite()).min(1).max(4096).parse(input.vector)
    const topK = z.number().int().min(1).max(10).parse(input.topK)
    const minScore = z.number().min(-1).max(1).parse(input.minScore)
    const candidates: MemorySearchResult[] = []
    for (const item of this.memory.list(input.namespace, 100)) {
      input.signal.throwIfAborted()
      const embedding = item.embedding
      if (embedding === null || embedding.model !== input.model || embedding.values.length !== vector.length
        || embedding.contentHash !== item.contentHash) continue
      const score = cosine(vector, embedding.values)
      if (score >= minScore) candidates.push({ item, score })
    }
    return candidates.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt) || a.item.id.localeCompare(b.item.id))
      .slice(0, topK)
  }
}
