/** Analysis presentation receives only authorized callbacks and locale-owned copy. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentVersionSummary, ObservationQuery, ObservationReport, ObservationRunPage } from '@deepseek-ai/dsh-agent-builder/types'
import css from './AgentRegistry.module.css'

/** Apply-owned authorized analysis callbacks. */
export interface AnalyticsActions {
  observabilityQuery(workspace: string, query: ObservationQuery): Promise<ObservationReport>
  observabilityRuns(workspace: string, query: ObservationQuery, cursor?: string): Promise<ObservationRunPage>
}
type Props = PropsLocale<'agentRegistry'> & AnalyticsActions & {
  workspace: string
  agentId?: string | undefined
  versions?: AgentVersionSummary[] | undefined
}

/** Display one stable cohort and links back to existing Trace details.
 * @param props - workspace, optional Agent scope, callbacks and locale.
 * @returns Agent or workspace analysis panel.
 */
export function AgentAnalytics(props: Props) {
  const { t, workspace, agentId } = props
  const [resourceSort, setResourceSort] = useState('failures')
  const [window, setWindow] = useState('7')
  const [versionId, setVersion] = useState('')
  const [compareVersionId, setCompare] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<{ query: ObservationQuery; report: ObservationReport } | null>(null)
  const [page, setPage] = useState<ObservationRunPage | null>(null)
  const [drillQuery, setDrillQuery] = useState<ObservationQuery | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const actions = useRef(props); actions.current = props
  useEffect(() => {
    let alive = true
    setBusy(true); setPage(null); setError(null); setData(null)
    const query: ObservationQuery = { window: window === 'last' ? { kind: 'last', count: 1000 }
      : { kind: 'time', from: new Date(Date.now() - Number(window) * 86400000).toISOString(), to: new Date().toISOString() },
    ...(agentId === undefined ? {} : { agentId }), ...(versionId ? { versionId } : {}), ...(compareVersionId ? { compareVersionId } : {}) }
    void actions.current.observabilityQuery(workspace, query).then((report) => { if (alive) setData({ query, report }) },
      (failure: unknown) => { if (alive) setError(String(failure)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [workspace, agentId, window, versionId, compareVersionId, refresh])
  const number = (value: number | null) => value === null ? t('unknown') : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const rate = (value: number | null) => value === null ? t('unknown') : `${(value * 100).toFixed(1)}%`
  const drill = async (query: ObservationQuery, cursor?: string) => {
    setBusy(true)
    try {
      const next = await props.observabilityRuns(workspace, query, cursor)
      if (next.revision !== data?.report.revision) { setRefresh(value => value + 1); return }
      setPage(next); setDrillQuery(query); setError(null)
    } catch (failure) { setError(String(failure)) }
    finally { setBusy(false) }
  }
  const summary = data?.report.summary
  const resourceValue = (row: import('@deepseek-ai/dsh-agent-builder/types').ResourceMetrics) => {
    if (resourceSort.startsWith('cost:')) return Number(row.costs.find(cost => cost.currency === resourceSort.slice(5))?.nanoUnits ?? -1)
    return resourceSort === 'timeouts' ? row.calls.timeoutRate ?? -1 : row.calls.failed
  }
  const resources = [...data?.report.resources ?? []].sort((a, b) => resourceValue(b) - resourceValue(a))
  return <section aria-label={t('analytics')} className={css.detail}>
    <h2>{t('analytics')}</h2><p>{t('analyticsHint')}</p>
    <div className={css.actions}>
      <label>{t('analyticsWindow')}<select value={window} onChange={(event) => { setWindow(event.target.value) }}>
        <option value="1">{t('analyticsDay')}</option><option value="7">{t('analyticsWeek')}</option>
        <option value="30">{t('analyticsMonth')}</option><option value="last">{t('analyticsLast')}</option>
      </select></label>
      {agentId !== undefined && <>
        <label>{t('analyticsBaseline')}<select value={versionId} onChange={(event) => { setVersion(event.target.value) }}><option value="">{t('analyticsAll')}</option>
          {props.versions?.map(version => <option key={version.id} value={version.id}>{version.versionNumber}</option>)}</select></label>
        <label>{t('analyticsCompare')}<select value={compareVersionId} onChange={(event) => { setCompare(event.target.value) }}><option value="">{t('analyticsAll')}</option>
          {props.versions?.map(version => <option key={version.id} value={version.id}>{version.versionNumber}</option>)}</select></label>
      </>}
      <Button variant="outline" disabled={busy} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button>
    </div>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">{t('loading')}</p>}
    {data && summary && <>
      <p role="status">{t(data.report.dataState === 'complete' ? 'analyticsComplete' : 'analyticsPartial')} · {data.report.indexedRunCount} / {data.report.eligibleRunCount}</p>
      <dl className={css.traceMetrics}>
        <div><dt>{t('analyticsSamples')}</dt><dd>{summary.sampleCount}</dd></div>
        <div><dt>{t('analyticsSuccess')}</dt><dd>{rate(summary.successRate)}</dd></div>
        <div><dt>{t('analyticsCancelled')}</dt><dd>{summary.cancelled}</dd></div>
        <div><dt>{t('analyticsLatency')}</dt><dd>{number(summary.latency.average)} / {number(summary.latency.p95)}</dd></div>
        <div><dt>{t('analyticsTokens')}</dt><dd>{number(summary.tokens.average)}</dd></div>
        <div><dt>{t('analyticsCoverage')}</dt><dd>{summary.tokens.validCount} / {summary.sampleCount}</dd></div>
        <div><dt>{t('analyticsInterventions')}</dt><dd>{summary.interventionRuns}</dd></div>
        <div><dt>{t('analyticsRejected')}</dt><dd>{summary.rejectedCalls}</dd></div>
        <div><dt>{t('analyticsUnpriced')}</dt><dd>{summary.unpricedCalls}</dd></div>
      </dl>
      <p>{t('analyticsActive')}: {data.report.active.map(row => `${row.status}: ${row.count}`).join(' · ')} · {t('analyticsUnknownTime')}: {data.report.unknownTimeCount}</p>
      {summary.costs.map(cost => <p key={cost.currency}>{t('analyticsCost')}: {cost.currency} {number(Number(cost.nanoUnits) / 1e9)} · {cost.pricedCalls}</p>)}
      <Button variant="outline" disabled={busy} onClick={() => { void drill(data.query) }}>{t('analyticsDrill')}</Button>
      {data.report.comparison && <><h3>{t('analyticsCompare')}</h3>
        {data.report.comparison.lowSample && <p>{t('analyticsLowSample')}</p>}
        <p>{data.report.comparison.versionId} · {t('analyticsSamples')}: {data.report.comparison.summary.sampleCount} · {t('analyticsSuccess')}: {rate(data.report.comparison.summary.successRate)} · {t('analyticsLatency')}: {number(data.report.comparison.summary.latency.average)} / {number(data.report.comparison.summary.latency.p95)} · {t('analyticsTokens')}: {number(data.report.comparison.summary.tokens.average)}</p></>}
      <h3>{t('analyticsErrors')}</h3>{summary.errors.map(error => <p key={error.category}>{error.category}: {error.count} ({rate(error.count / summary.failed)}) <Button variant="outline" onClick={() => { void drill({ ...data.query, errorCategory: error.category }) }}>{t('analyticsDrill')}</Button></p>)}
      <h3>{t('analyticsDependencies')}</h3>
      <label>{t('analyticsSort')}<select value={resourceSort} onChange={(event) => { setResourceSort(event.target.value) }}>
        <option value="failures">{t('analyticsErrors')}</option><option value="timeouts">{t('analyticsTimeout')}</option>
        {summary.costs.map(cost => <option key={cost.currency} value={`cost:${cost.currency}`}>{t('analyticsCost')} · {cost.currency}</option>)}
      </select></label><div className={css.analysisTable}><table><thead><tr>
        <th>{t('name')}</th><th>{t('analyticsCalls')}</th><th>{t('analyticsToolSuccess')}</th><th>{t('analyticsTimeout')}</th><th>{t('analyticsLatency')}</th><th>{t('analyticsAffected')}</th><th>{t('analyticsCost')}</th><th>{t('analyticsDrill')}</th>
      </tr></thead><tbody>{resources.map(resource => <tr key={resource.key}>
        <td>{resource.name}<small>{resource.resourceVersionId}</small></td>
        <td>{resource.calls.count}</td><td>{rate(resource.calls.successRate)}</td><td>{rate(resource.calls.timeoutRate)}</td>
        <td>{number(resource.calls.latency.average)} / {number(resource.calls.latency.p95)}</td>
        <td>{resource.affectedAgents} / {resource.affectedRuns}</td>
        <td>{resource.costs.length ? resource.costs.map(cost => `${cost.currency} ${(Number(cost.nanoUnits) / 1e9).toFixed(6)}`)
          .join(', ') : t('unknown')}</td>
        <td><Button variant="outline" disabled={busy} onClick={() => { void drill({ ...data.query, resourceKey: resource.key }) }}>{t('analyticsDrill')}</Button></td>
      </tr>)}</tbody></table></div>
      <h3>{t('analyticsTrend')}</h3>{data.report.trend.map(row => <p key={row.date}>{row.date} · {t('analyticsSamples')}: {row.summary.sampleCount} · {t('analyticsSuccess')}: {rate(row.summary.successRate)} · {t('analyticsLatency')}: {number(row.summary.latency.p95)}</p>)}
      {page && <section aria-label={t('analyticsDrill')}><h3>{t('analyticsDrill')}</h3>{page.items.map(row => <p key={row.runId}><a href={`#agents/${row.agentId}/runs/${row.runId}`}>{row.runId}</a> · {row.status}</p>)}
        {page.nextCursor && drillQuery && <Button variant="outline" disabled={busy} onClick={() => { void drill(drillQuery, page.nextCursor ?? undefined) }}>{t('traceMore')}</Button>}</section>}
    </>}
  </section>
}
