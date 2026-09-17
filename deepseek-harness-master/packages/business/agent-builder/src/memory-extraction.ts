/** Narrow, structured extraction seam for durable Memory writeback. */
import { z } from 'zod'
import type { MemoryScope } from './memory-types.ts'

/** Candidate proposed by an extractor, always tied to source Session sequence numbers. */
export interface ExtractedMemory {
  scope: MemoryScope
  kind: 'session_summary' | 'semantic_fact'
  content: string
  messageStartSeq: number
  messageEndSeq: number
}

/** Input frozen before an extractor observes one completed Run. */
export interface MemoryExtractionRequest {
  run: { id: string; sessionId: string; agentId: string; agentVersionId: string }
  storeId: string
  allowedScopes: readonly MemoryScope[]
  allowSessionSummary: boolean
  allowSemanticFact: boolean
  signal: AbortSignal
}

/** An explicit host-owned extraction capability; it may read the durable Session transcript. */
export interface MemoryExtractor {
  extract(input: MemoryExtractionRequest): Promise<readonly ExtractedMemory[]>
}

/** Validate untrusted extractor output before it reaches durable storage.
 * @param value - extractor-produced candidate.
 * @returns bounded candidate with an ordered source range.
 */
export function extractedMemory(value: ExtractedMemory): ExtractedMemory {
  return z.strictObject({ scope: z.enum(['session', 'user', 'agent']), kind: z.enum(['session_summary', 'semantic_fact']),
    content: z.string().trim().min(1).max(32000), messageStartSeq: z.number().int().nonnegative(), messageEndSeq: z.number().int().nonnegative() })
    .refine(row => row.messageEndSeq >= row.messageStartSeq, 'Memory source sequence range is invalid').parse(value)
}
