// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PlatformRun, RegistryAgent } from '@deepseek-ai/dsh-agent-builder/types'
import type {} from '../src/client/registry-client.ts'
import { RunDetails, runDuration } from '../src/client/RunDetails.tsx'
import { AgentRuns } from '../src/client/AgentRuns.tsx'
import { registryEn } from '../src/client/registry-locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); window.location.hash = '' })
const dictionary: Record<string, string> = registryEn
const t = (key: string) => dictionary[key] ?? key
const run: PlatformRun = {
  id: brandString<PlatformRun['id']>('run-a'), agentId: brandString<PlatformRun['agentId']>('agent-a'), agentVersionId: brandString<PlatformRun['agentVersionId']>('version-a'), versionNumber: 3,
  platformWorkspaceId: 'shared', configHash: 'hash', deploymentRevision: 1, sessionId: brandString<PlatformRun['sessionId']>('session-a'), createdBy: 'shared-host',
  createdAt: '2026-09-17T01:00:00.000Z', startedAt: '2026-09-17T01:00:02.000Z', finishedAt: '2026-09-17T01:00:20.000Z',
  finishTimeSource: 'execution', status: 'SUCCEEDED', cancelRequestedAt: null, input: { prompt: 'Investigate alert' },
  result: { textPreview: 'Recovered', sessionId: brandString<PlatformRun['sessionId']>('session-a'), finalMessageSeq: 8 }, error: null, events: [],
}
const agent: RegistryAgent = { id: run.agentId, platformWorkspaceId: 'shared', name: 'SRE' } as RegistryAgent
describe('Run views', () => {
  it('freezes terminal duration and does not invent timing for interrupted or unstarted tasks', () => {
    expect(runDuration(run, Date.now())).toBe(18000)
    expect(runDuration({ ...run, finishTimeSource: 'detected' }, Date.now())).toBeNull()
    expect(runDuration({ ...run, startedAt: null }, Date.now())).toBeNull()
    const { container } = render(<RunDetails run={run} agentName="SRE" now={Date.now()} busy={false} t={t}
      cancel={vi.fn()} openExecution={vi.fn()} viewVersion={vi.fn()} />)
    expect(screen.getByText('Recovered')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel Run' })).toBeNull()
    expect(container.querySelector('[data-run-status]')?.getAttribute('data-run-status')).toBe('SUCCEEDED')
  })
  it('polls pending tasks until terminal and stops on unmount', async () => {
    vi.useFakeTimers()
    const runList = vi.fn().mockResolvedValueOnce({ items: [{ ...run, status: 'PENDING' }], nextCursor: null })
      .mockResolvedValue({ items: [run], nextCursor: null })
    const props = { t, agent, versions: [], refreshKey: 0, runList,
      runGet: vi.fn(), runCancel: vi.fn(), runTraceEvents: vi.fn(), openRun: vi.fn(), viewVersion: vi.fn() }
    const view = render(<AgentRuns {...props} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(runList).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(runList).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('opens a direct Run route and keeps cancellation pending until confirmed', async () => {
    vi.useFakeTimers()
    window.location.hash = '#agents/agent-a/runs/run-a'
    const current = { ...run, status: 'RUNNING' as const, finishedAt: null }
    const cancelled = { ...current, cancelRequestedAt: run.createdAt }
    const runGet = vi.fn().mockResolvedValue(current)
    const runCancel = vi.fn().mockResolvedValue(cancelled)
    const props = { t, agent, versions: [], refreshKey: 0, runList: vi.fn().mockResolvedValue({ items: [current], nextCursor: null }),
      runGet, runCancel, runTraceEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null, trace: { state: 'complete' } }), openRun: vi.fn(), viewVersion: vi.fn() }
    render(<AgentRuns {...props} />)
    await act(async () => { await Promise.resolve() })
    runGet.mockResolvedValue(cancelled)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel Run' })) })
    expect(runCancel).toHaveBeenCalledWith('shared', 'agent-a', 'run-a')
    expect(screen.getByRole('button', { name: 'Cancelling…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('region', { name: 'Run details' }).getAttribute('data-run-status')).toBe('RUNNING')
  })
})
