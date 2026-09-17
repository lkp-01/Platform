/** Durable model-visible message construction for retrieved Memory Items. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRetrieval } from './runtime-memory.ts'

/** Return direct text only; injected/plugin content never becomes a new retrieval query.
 * @param messages - accepted request messages.
 * @returns bounded direct user query text.
 */
export function directMemoryQuery(messages: readonly UserMessage[]): string {
  return messages.filter(message => message.source.kind === 'user').flatMap(message => message.content)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('\n').slice(0, 32000)
}

/** Render a Memory retrieval into a durable Context message.
 * @param retrieval - bounded retrieved Memory snapshot.
 * @returns plugin-attributed user message, or null when no item was included.
 */
export function memoryContextMessage(retrieval: MemoryRetrieval): UserMessage | null {
  if (retrieval.text === null) return null
  return createUserMessage({ content: [{ type: 'text', text: retrieval.text }],
    source: { kind: 'plugin', plugin: 'platform-memory', form: 'snapshot', sections: retrieval.items.map(item => ({
      name: item.itemId, text: `store=${item.storeId}; scope=${item.scope}; sourceRun=${item.sourceRunId ?? 'manual'}`,
    })) } })
}
