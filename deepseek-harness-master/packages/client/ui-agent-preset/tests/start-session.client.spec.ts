import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

describe('explicit preset session creation', () => {
  it('passes the selected preset, serializes duplicate clicks and clears busy only after creation', async () => {
    const seat = new AgentPresetSeatController({} as Context, () => undefined)
    seat.stage('data')
    let complete!: () => void
    const create = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
    const pending = seat.start(create)
    expect(seat.store.getSnapshot()).toMatchObject({ current: 'data', busy: true })
    await seat.start(create)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('data')
    complete()
    await pending
    expect(seat.store.getSnapshot()).toMatchObject({ current: 'data', busy: false, error: null })
  })
  it('keeps an actionable creation error and permits retry without silently changing presets', async () => {
    const seat = new AgentPresetSeatController({} as Context, () => undefined)
    seat.stage('operations')
    await seat.start(async () => { throw new Error('Preset unavailable') })
    expect(seat.store.getSnapshot()).toMatchObject({ current: 'operations', busy: false, error: 'Preset unavailable' })
    const retry = vi.fn(async () => {})
    await seat.start(retry)
    expect(retry).toHaveBeenCalledWith('operations')
    expect(seat.store.getSnapshot().error).toBeNull()
  })
})
