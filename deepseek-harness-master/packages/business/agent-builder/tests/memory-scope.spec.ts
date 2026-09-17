import { describe, expect, it } from 'vitest'
import { memoryNamespaceKey, resolveMemoryNamespace } from '../src/memory-schema.ts'

const base = { workspaceId: 'workspace-a', agentId: 'agent-a', userId: 'user-001', conversationId: 'conversation-a' }

describe('Memory Platform namespaces', () => {
  it('separates each scope by its trusted subject and workspace', () => {
    const user = resolveMemoryNamespace('customer-memory', 'user', base)
    const sameUserOtherAgent = resolveMemoryNamespace('customer-memory', 'user', { ...base, agentId: 'agent-b' })
    const otherUser = resolveMemoryNamespace('customer-memory', 'user', { ...base, userId: 'user-002' })
    const session = resolveMemoryNamespace('customer-memory', 'session', base)
    const otherSession = resolveMemoryNamespace('customer-memory', 'session', { ...base, conversationId: 'conversation-b' })
    const agent = resolveMemoryNamespace('customer-memory', 'agent', base)
    const otherAgent = resolveMemoryNamespace('customer-memory', 'agent', { ...base, agentId: 'agent-b' })
    const otherWorkspace = resolveMemoryNamespace('customer-memory', 'user', { ...base, workspaceId: 'workspace-b' })

    expect(memoryNamespaceKey(user)).toBe(memoryNamespaceKey(sameUserOtherAgent))
    expect(memoryNamespaceKey(user)).not.toBe(memoryNamespaceKey(otherUser))
    expect(memoryNamespaceKey(session)).not.toBe(memoryNamespaceKey(otherSession))
    expect(memoryNamespaceKey(agent)).not.toBe(memoryNamespaceKey(otherAgent))
    expect(memoryNamespaceKey(user)).not.toBe(memoryNamespaceKey(otherWorkspace))
  })

  it('rejects user scope without a verified user identity', () => {
    expect(() => resolveMemoryNamespace('customer-memory', 'user', { ...base, userId: null })).toThrow('authenticated user')
  })

  it('rejects malformed externally supplied namespace values', () => {
    expect(() => memoryNamespaceKey({ ...resolveMemoryNamespace('customer-memory', 'user', base), subjectId: '' })).toThrow()
  })
})
