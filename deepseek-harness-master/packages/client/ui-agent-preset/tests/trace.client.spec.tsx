// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlatformRun, RunTracePage } from '@deepseek-ai/dsh-agent-builder/types'
import type {} from '../src/client/registry-client.ts'
import { RunTrace } from '../src/client/RunTrace.tsx'
import { registryEn } from '../src/client/registry-locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const dictionary: Record<string, string> = registryEn
const t = (key: string) => dictionary[key] ?? key
const run = { id: 'run-a', agentId: 'agent-a', platformWorkspaceId: 'shared', status: 'SUCCEEDED' } as PlatformRun
const result: RunTracePage = { trace: { runId: run.id, agentId: run.agentId, agentVersionId: run.agentVersionId,
  sessionId: run.sessionId, platformWorkspaceId: 'shared', revision: 'one', state: 'complete', eventCount: 1,
  modelCalls: 1, toolCalls: 0, inputTokens: 15, outputTokens: 4, totalTokens: 19, usageComplete: true },
items: [{ eventId: 'answer', type: 'final.answer', occurredAt: '2026-09-17T01:00:00Z', sourceSeq: 4, sourceRunEventId: null,
  operationId: null, turn: null, step: null, provider: null, model: null, tool: null, durationMs: null, usage: null,
  error: null, incomplete: false, preview: { text: '<script>untrusted</script>', redacted: true, truncated: true } }], nextCursor: null }

describe('Run Trace timeline', () => {
  it('continues until the trace settles even when the Run is terminal, then stops polling', async () => {
    vi.useFakeTimers()
    const load = vi.fn().mockResolvedValueOnce({ ...result, trace: { ...result.trace, state: 'pending', totalTokens: null, usageComplete: false } }).mockResolvedValue(result)
    const view = render(<RunTrace t={t} run={run} load={load} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Token accounting is incomplete. Unknown usage is not counted as zero.')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('19')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(load).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('script')).toBeNull()
    expect(screen.getByText('Preview truncated.')).toBeTruthy()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('shows a recoverable query error and retries through Refresh', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Trace changed')).mockResolvedValue(result)
    render(<RunTrace t={t} run={run} load={load} />)
    await screen.findByRole('alert')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Final answer')).toBeTruthy()
  })
})
