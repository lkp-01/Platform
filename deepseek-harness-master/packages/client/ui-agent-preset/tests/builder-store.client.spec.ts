import { describe, expect, it, vi } from 'vitest'
import { AgentBuilderController } from '../src/client/builder-store.ts'
import type { AgentBuilderCatalog, AgentDefinition } from '@deepseek-ai/dsh-agent-builder/types'

const catalog: AgentBuilderCatalog = { models: { default: { provider: 'demo', model: 'one' }, routableProviders: ['demo'], groups: [{ id: 'demo', name: 'Demo', models: [{ id: 'one', name: 'One' }] }], failures: [] }, tools: [], agents: [] }
const saved: AgentDefinition = { id: 'agent-test' as AgentDefinition['id'], builtin: false, name: 'Test', prompt: 'Help', model: { provider: 'demo', model: 'one' }, toolIds: [] }

describe('Agent creation draft', () => {
  it('fills templates without retaining identity or mutating the source', async () => {
    const controller = new AgentBuilderController({
      catalog: async () => catalog, create: async () => saved, start: async () => {}, refreshed() {},
    })
    await controller.open()
    controller.begin(saved)
    controller.change({ toolIds: ['order_query'], prompt: 'Changed' })
    expect(saved.prompt).toBe('Help')
    expect(saved.toolIds).toEqual([])
    expect(controller.store.getSnapshot().draft).not.toHaveProperty('id')
  })
  it('keeps the submission token and draft on failure, then exposes the committed result', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(saved)
    const controller = new AgentBuilderController({ catalog: async () => catalog, create, start: async () => {}, refreshed() {} })
    await controller.open()
    controller.begin(saved)
    await controller.save()
    expect(controller.store.getSnapshot().error).toBe('offline')
    await controller.save()
    expect(create.mock.calls[0]![1]).toBe(create.mock.calls[1]![1])
    expect(controller.store.getSnapshot()).toMatchObject({ view: 'list', created: saved.id, busy: false, error: null })
    expect(controller.store.getSnapshot().catalog?.agents).toEqual([saved])
  })
  it('prevents duplicate clicks and blocks navigation during a write', async () => {
    let resolve!: (value: AgentDefinition) => void
    const create = vi.fn(() => new Promise<AgentDefinition>((done) => { resolve = done }))
    const controller = new AgentBuilderController({ catalog: async () => catalog, create, start: async () => {}, refreshed() {} })
    await controller.open()
    controller.begin(saved)
    const pending = controller.save()
    await controller.save()
    controller.close()
    controller.begin()
    expect(controller.store.getSnapshot()).toMatchObject({ open: true, busy: true, draft: { name: 'Test' } })
    resolve(saved)
    await pending
    expect(create).toHaveBeenCalledTimes(1)
  })
})
