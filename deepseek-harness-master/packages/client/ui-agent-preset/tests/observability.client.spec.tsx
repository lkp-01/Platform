// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {} from '../src/client/registry-client.ts'
import { AgentAnalytics } from '../src/client/AgentAnalytics.tsx'
import { registryEn } from '../src/client/registry-locales.ts'
import { summarize } from '../../../business/agent-builder/src/observability-metrics.ts'
import type { ObservationReport } from '@deepseek-ai/dsh-agent-builder/types'

afterEach(cleanup)
const dictionary: Record<string, string> = registryEn
const report: ObservationReport = { revision: 'one', asOf: '2026-09-17T00:00:00Z', dataState: 'partial', indexedRunCount: 0,
  eligibleRunCount: 1, lagMs: 100, missingReasons: ['projection_pending'], summary: summarize([]), comparison: null,
  agents: [], resources: [], trend: [], active: [], unknownTimeCount: 0 }

it('shows missing measurements and refreshes stale drill-down rather than mixing snapshots', async () => {
  const load = vi.fn().mockResolvedValue(report)
  const page = vi.fn().mockResolvedValue({ revision: 'new', items: [], nextCursor: null })
  render(<AgentAnalytics workspace="shared" t={key => dictionary[key]!} observabilityQuery={load} observabilityRuns={page} />)
  await screen.findByText(/Data incomplete/)
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Matching runs' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'last' } })
  await waitFor(() => expect(load).toHaveBeenLastCalledWith('shared', { window: { kind: 'last', count: 1000 } }))
})

it('links the selected cohort to an existing Run detail and surfaces query failure', async () => {
  const load = vi.fn().mockResolvedValue(report)
  const page = vi.fn().mockResolvedValue({ revision: 'one', items: [{ runId: 'run-a', agentId: 'agent-a', status: 'FAILED' }], nextCursor: null })
  render(<AgentAnalytics workspace="shared" agentId="agent-a" t={key => dictionary[key]!} observabilityQuery={load} observabilityRuns={page} />)
  await screen.findByText(/Data incomplete/)
  fireEvent.click(screen.getByRole('button', { name: 'Matching runs' }))
  expect((await screen.findByRole('link', { name: 'run-a' })).getAttribute('href')).toBe('#agents/agent-a/runs/run-a')
  load.mockRejectedValueOnce(new Error('Unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('alert')
})
