import { useMemo, useState } from 'react'
import { api, routes } from '../lib/client'
import { humanizeKey } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { AnalyticsDashboardPayload, AnalyticsPayload } from '../lib/types'
import { EmptyState, ErrorState, LoadingState, MetricCard, PageSection } from '../components/ui'

export const handle = {
  title: 'Analytics',
  subtitle: 'Firm analytics with filters, cards, tables, and in-page CSV export.',
  breadcrumb: 'Analytics'
}

interface AnalyticsPageData {
  analytics: AnalyticsPayload
  dashboard: AnalyticsDashboardPayload
}

function numericEntries(summary: Record<string, unknown>) {
  return Object.entries(summary).filter(([, value]) => typeof value === 'number')
}

export function Component() {
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    cohortBy: 'all',
    cohortValue: ''
  })

  const { data, error, loading } = useAsync<AnalyticsPageData>(
    async () => {
      const query = {
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        cohortBy: filters.cohortBy || undefined,
        cohortValue: filters.cohortValue || undefined
      }
      const [analytics, dashboard] = await Promise.all([
        api.get<AnalyticsPayload>(routes.analytics(query)),
        api.get<AnalyticsDashboardPayload>(routes.analyticsDashboard(query))
      ])
      return { analytics, dashboard }
    },
    [filters.startDate, filters.endDate, filters.cohortBy, filters.cohortValue]
  )

  const summaryEntries = useMemo(
    () => numericEntries((data?.analytics.summary as Record<string, unknown>) || {}),
    [data?.analytics.summary]
  )
  const csvHref = routes.analyticsExport({
    startDate: filters.startDate || undefined,
    endDate: filters.endDate || undefined,
    cohortBy: filters.cohortBy || undefined,
    cohortValue: filters.cohortValue || undefined
  })

  if (loading) return <LoadingState label="Loading analytics" />
  if (error || !data) return <ErrorState title="Analytics failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageSection
        title="Filters"
        subtitle="Adjust cohort and date inputs without leaving the analytics route."
        action={
          <a className="text-link" href={csvHref}>
            Export CSV
          </a>
        }
      >
        <div className="form-grid two-up">
          <label>
            <span>Start date</span>
            <input type="date" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))} />
          </label>
          <label>
            <span>End date</span>
            <input type="date" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))} />
          </label>
          <label>
            <span>Cohort by</span>
            <select value={filters.cohortBy} onChange={(event) => setFilters((current) => ({ ...current, cohortBy: event.target.value }))}>
              <option value="all">All</option>
              <option value="advisor">Advisor</option>
              <option value="stage">Stage</option>
              <option value="source">Source</option>
            </select>
          </label>
          <label>
            <span>Cohort value</span>
            <input value={filters.cohortValue} onChange={(event) => setFilters((current) => ({ ...current, cohortValue: event.target.value }))} />
          </label>
        </div>
      </PageSection>

      <div className="metrics-grid">
        {summaryEntries.length ? (
          summaryEntries.map(([key, value]) => <MetricCard key={key} label={humanizeKey(key)} value={value} />)
        ) : (
          <MetricCard label="Summary" value="No metrics" hint="The analytics summary did not include numeric aggregates." />
        )}
      </div>

      <div className="split-grid">
        <PageSection title="Funnel" subtitle="Current funnel counts from the analytics dashboard endpoint.">
          {data.dashboard.funnel?.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Count</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dashboard.funnel.map((row, index) => (
                    <tr key={`funnel-${index}`}>
                      <td>{String(row.label || row.stage || row.id || `Stage ${index + 1}`)}</td>
                      <td>{String(row.count || row.total || 0)}</td>
                      <td>{JSON.stringify(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No funnel data." detail="The backend did not return funnel rows for the current filter set." />
          )}
        </PageSection>

        <PageSection title="Bottlenecks" subtitle="Aging and delays surface directly on the analytics route.">
          {data.dashboard.bottlenecks?.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Signal</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dashboard.bottlenecks.map((row, index) => (
                    <tr key={`bottleneck-${index}`}>
                      <td>{String(row.stage || row.label || `Item ${index + 1}`)}</td>
                      <td>{String(row.status || row.days || row.count || 'Observed')}</td>
                      <td>{JSON.stringify(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No bottlenecks reported." detail="Nothing surfaced as a bottleneck for the current filters." />
          )}
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection title="Stage aging" subtitle="Ordered aging data from the analytics dashboard response.">
          {data.dashboard.stageAgingOrdered?.length ? (
            <pre className="json-block">{JSON.stringify(data.dashboard.stageAgingOrdered, null, 2)}</pre>
          ) : (
            <EmptyState title="No stage aging data." detail="The backend did not return ordered aging rows." />
          )}
        </PageSection>

        <PageSection title="Form and export throughput" subtitle="Completion latency and export usage stay visible without opening diagnostics.">
          <div className="compact-stack">
            {data.dashboard.formCompletionLatency?.length ? (
              <pre className="json-block">{JSON.stringify(data.dashboard.formCompletionLatency, null, 2)}</pre>
            ) : (
              <EmptyState title="No form latency data." detail="No form latency rows were returned." />
            )}
            {data.dashboard.exportUsage ? (
              <pre className="json-block">{JSON.stringify(data.dashboard.exportUsage, null, 2)}</pre>
            ) : (
              <EmptyState title="No export usage summary." detail="The analytics endpoint did not return export usage data." />
            )}
          </div>
        </PageSection>
      </div>
    </div>
  )
}
