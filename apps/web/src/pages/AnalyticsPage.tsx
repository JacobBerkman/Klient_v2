import { useMemo, useState } from 'react'
import { api, routes } from '../lib/client'
import { formatCount, formatDays, formatHours, formatPercent, humanizeKey } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { AnalyticsDashboardPayload, AnalyticsPayload } from '../lib/types'
import { HorizontalBarChart, StackedBarChart, StatTrendRow } from '../components/charts'
import {
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  PageHero,
  PageSection,
  StatGroup,
  Toolbar
} from '../components/ui'

export const handle = {
  title: 'Analytics',
  subtitle: 'Firm analytics with filters, cards, tables, and in-page CSV export.',
  breadcrumb: 'Analytics'
}

interface AnalyticsPageData {
  analytics: AnalyticsPayload
  dashboard: AnalyticsDashboardPayload
}

function numericEntries(summary: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(summary).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
}

function formatSummaryMetric(key: string, value: number) {
  const normalized = key.toLowerCase()
  if (normalized.includes('rate')) return formatPercent(value)
  if (normalized.includes('days')) return formatDays(value)
  return formatCount(value)
}

function exportStatusColor(status: string) {
  const normalized = status.toLowerCase()
  if (normalized.includes('complete')) return 'var(--chart-good)'
  if (normalized.includes('fail') || normalized.includes('dead')) return 'var(--chart-bad)'
  if (
    normalized.includes('queue') ||
    normalized.includes('run') ||
    normalized.includes('retry') ||
    normalized.includes('pend')
  ) {
    return 'var(--chart-warn)'
  }
  return 'var(--chart-neutral)'
}

function RawData({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="raw-data-details">
      <summary>View raw data{label ? ` (${label})` : ''}</summary>
      <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

export function Component() {
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    cohortBy: 'all',
    cohortValue: ''
  })

  const { data, error, loading } = useAsync<AnalyticsPageData>(async () => {
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
  }, [filters.startDate, filters.endDate, filters.cohortBy, filters.cohortValue])

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

  const summary = data.analytics.summary || {}
  const stageLabels = new Map(
    (data.dashboard.stageMetadata || []).map((stage) => [stage.id, stage.label || humanizeKey(stage.id)])
  )
  const stageLabel = (stageId: string) => stageLabels.get(stageId) || humanizeKey(stageId)

  const funnel = data.dashboard.funnel || []
  const totalProspects = funnel.reduce((sum, row) => sum + (row.count || 0), 0)
  const funnelRows = funnel.map((row) => ({
    key: row.stage,
    label: stageLabel(row.stage),
    value: row.count || 0,
    hover: `${stageLabel(row.stage)}: ${formatCount(row.count || 0)} prospects (${formatPercent(row.conversionRate)} of the funnel)`
  }))
  const stageAging = data.dashboard.stageAgingOrdered || []
  const terminalStage = stageAging.find((row) => row.isTerminal && !row.isDrop)
  const funnelSummary = totalProspects
    ? `${formatCount(totalProspects)} prospects in the funnel; ${formatPercent(
        summary.overallConversionRate || 0
      )} of those entering the first stage reach ${terminalStage ? stageLabel(terminalStage.stage) : 'the final stage'}.`
    : ''

  const bottlenecks = data.dashboard.bottlenecks || []
  const bottleneckRows = bottlenecks.map((row) => ({
    key: row.stage,
    label: stageLabel(row.stage),
    value: row.avgDays || 0,
    detail: `${formatCount(row.count)} prospects`
  }))
  const worstBottleneck = bottlenecks[0]

  const stageAgingRows = stageAging.map((row) => ({
    key: row.stage,
    label: stageLabel(row.stage),
    value: row.avgDays || 0,
    detail: `${formatCount(row.count)} prospects`
  }))

  const completionRates = summary.formCompletionRates || []
  const completionTotals = completionRates.reduce(
    (acc, row) => ({ submitted: acc.submitted + (row.submitted || 0), drafts: acc.drafts + (row.drafts || 0) }),
    { submitted: 0, drafts: 0 }
  )
  const completionDenominator = completionTotals.submitted + completionTotals.drafts

  const latency = data.dashboard.formCompletionLatency || []
  const fastestTemplate = latency.length
    ? latency.reduce((best, row) => (row.avgHours < best.avgHours ? row : best), latency[0])
    : null

  const advisorProductivity = summary.advisorProductivity || []
  const topAdvisor = advisorProductivity.length
    ? advisorProductivity.reduce(
        (best, row) => (row.productivityScore > best.productivityScore ? row : best),
        advisorProductivity[0]
      )
    : null

  const exportUsage = data.dashboard.exportUsage
  const exportStatuses = Object.entries(exportUsage?.byFirm?.byStatus || {})
  const exportTotal = exportUsage?.byFirm?.total || 0
  const exportAdvisorRows = (exportUsage?.byAdvisor || []).map((row) => ({
    key: row.advisorUserId || 'unknown',
    label: row.advisorName || 'Unknown',
    value: row.total || 0
  }))

  return (
    <div className="stack">
      <PageHero
        eyebrow="Analytics"
        title="Spot movement, bottlenecks, and throughput"
        subtitle="Use date and cohort filters to narrow operational metrics, then export CSV from the same screen."
        actions={
          <a className="primary-button button-link" href={csvHref}>
            Export CSV
          </a>
        }
      />
      <PageSection
        title="Filters"
        subtitle="Adjust cohort and date inputs without leaving the analytics route."
        action={
          <a className="text-link" href={csvHref}>
            Export CSV
          </a>
        }
      >
        <Toolbar label="Analytics filters">
          <Field label="Start date">
            <input
              type="date"
              value={filters.startDate}
              onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={filters.endDate}
              onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
            />
          </Field>
          <Field label="Cohort by">
            <select
              value={filters.cohortBy}
              onChange={(event) => setFilters((current) => ({ ...current, cohortBy: event.target.value }))}
            >
              <option value="all">All</option>
              <option value="advisor">Advisor</option>
              <option value="stage">Stage</option>
              <option value="source">Source</option>
            </select>
          </Field>
          <Field label="Cohort value">
            <input
              value={filters.cohortValue}
              onChange={(event) => setFilters((current) => ({ ...current, cohortValue: event.target.value }))}
            />
          </Field>
        </Toolbar>
      </PageSection>

      <StatGroup>
        {summaryEntries.length ? (
          summaryEntries.map(([key, value]) => (
            <MetricCard key={key} label={humanizeKey(key)} value={formatSummaryMetric(key, value)} />
          ))
        ) : (
          <MetricCard
            label="Summary"
            value="No metrics"
            hint="The analytics summary did not include numeric aggregates."
          />
        )}
      </StatGroup>

      <div className="split-grid">
        <PageSection title="Funnel" subtitle="Prospect counts by pipeline stage for the current filter set.">
          <div className="chart-block">
            {funnelSummary ? <p className="chart-summary">{funnelSummary}</p> : null}
            <HorizontalBarChart
              title="Funnel by stage"
              description={`Prospect counts per pipeline stage. ${funnelSummary || 'No prospects match the current filters.'}`}
              rows={funnelRows}
              color="var(--chart-cat-1)"
              valueHeader="Prospects"
              emptyTitle="No funnel data."
              emptyDetail="The backend did not return funnel rows for the current filter set."
              testId="funnel-chart"
            />
            {funnel.length ? <RawData label="funnel" value={funnel} /> : null}
          </div>
        </PageSection>

        <PageSection title="Bottlenecks" subtitle="Active stages ranked by how long prospects have been waiting.">
          <div className="chart-block">
            {worstBottleneck ? (
              <p className="chart-summary">
                Prospects wait longest in {stageLabel(worstBottleneck.stage)} ({formatDays(worstBottleneck.avgDays)} on
                average).
              </p>
            ) : null}
            <HorizontalBarChart
              title="Bottlenecks by average days in stage"
              description="Active pipeline stages ranked by the average number of days current prospects have spent in them."
              rows={bottleneckRows}
              color="var(--chart-cat-2)"
              formatValue={formatDays}
              valueHeader="Average days in stage"
              emptyTitle="No bottlenecks reported."
              emptyDetail="Nothing surfaced as a bottleneck for the current filters."
              testId="bottlenecks-chart"
            />
            {bottlenecks.length ? <RawData label="bottlenecks" value={bottlenecks} /> : null}
          </div>
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection title="Stage aging" subtitle="Average days prospects have spent in each pipeline stage.">
          <div className="chart-block">
            {typeof summary.avgProspectStageAgeDays === 'number' && stageAgingRows.length ? (
              <p className="chart-summary">
                Active-stage prospects average {formatDays(summary.avgProspectStageAgeDays)} in their current stage.
              </p>
            ) : null}
            <HorizontalBarChart
              title="Stage aging"
              description="Average days in stage for every pipeline stage, with the number of prospects currently sitting in each."
              rows={stageAgingRows}
              color="var(--chart-cat-3)"
              formatValue={formatDays}
              valueHeader="Average days in stage"
              emptyTitle="No stage aging data."
              emptyDetail="The backend did not return ordered aging rows."
              testId="stage-aging-chart"
            />
            {stageAging.length ? <RawData label="stage aging" value={stageAging} /> : null}
          </div>
        </PageSection>

        <PageSection
          title="Form and export throughput"
          subtitle="Completion status, completion latency, and export usage stay visible without opening diagnostics."
        >
          <div className="compact-stack">
            <div className="chart-block">
              {completionDenominator ? (
                <p className="chart-summary">
                  {formatCount(completionTotals.submitted)} of {formatCount(completionDenominator)} forms submitted (
                  {formatPercent(completionDenominator ? completionTotals.submitted / completionDenominator : 0)}).
                </p>
              ) : null}
              <StackedBarChart
                title="Form completion by template"
                description="Submitted versus draft form counts for each template."
                series={[
                  { key: 'submitted', label: 'Submitted', color: 'var(--chart-cat-1)' },
                  { key: 'drafts', label: 'Still in draft', color: 'var(--chart-cat-1-soft)' }
                ]}
                rows={completionRates.map((row) => ({
                  key: row.templateId,
                  label: row.templateId,
                  values: [row.submitted || 0, row.drafts || 0],
                  detail: `${formatPercent(row.completionRate)} complete`
                }))}
                emptyTitle="No form activity."
                emptyDetail="No drafts or submissions were returned for the current filters."
                testId="form-completion-chart"
              />
            </div>
            <div className="chart-block">
              {fastestTemplate ? (
                <p className="chart-summary">
                  Fastest template turns around in {formatHours(fastestTemplate.avgHours)} on average.
                </p>
              ) : null}
              <HorizontalBarChart
                title="Form completion latency"
                description="Average hours from draft creation to submission, per template."
                rows={latency.map((row) => ({
                  key: row.templateId,
                  label: row.templateId,
                  value: row.avgHours || 0,
                  detail: `${formatCount(row.submissions)} submissions`
                }))}
                color="var(--chart-cat-2)"
                formatValue={formatHours}
                valueHeader="Average hours to submit"
                emptyTitle="No form latency data."
                emptyDetail="No submitted forms were returned for the current filters."
                testId="form-latency-chart"
              />
            </div>
            {completionRates.length || latency.length ? (
              <RawData
                label="forms"
                value={{ formCompletionRates: completionRates, formCompletionLatency: latency }}
              />
            ) : null}
          </div>
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection title="Advisor productivity" subtitle="Profiles, notes, stage moves, and forms per advisor.">
          <div className="chart-block">
            {topAdvisor ? (
              <p className="chart-summary">
                {topAdvisor.advisorName} leads with a productivity score of{' '}
                {formatCount(topAdvisor.productivityScore)}.
              </p>
            ) : null}
            <StackedBarChart
              title="Advisor productivity"
              description="Each advisor's productivity score broken into profiles managed, notes authored, stage moves, and form submissions."
              series={[
                { key: 'profiles', label: 'Profiles managed', color: 'var(--chart-cat-1)' },
                { key: 'notes', label: 'Notes authored', color: 'var(--chart-cat-2)' },
                { key: 'moves', label: 'Stage moves', color: 'var(--chart-cat-3)' },
                { key: 'forms', label: 'Form submissions', color: 'var(--chart-cat-4)' }
              ]}
              rows={advisorProductivity.map((row) => ({
                key: row.advisorUserId,
                label: row.advisorName,
                values: [
                  row.profilesManaged || 0,
                  row.notesAuthored || 0,
                  row.stageMoves || 0,
                  row.formSubmissionsAuthored || 0
                ]
              }))}
              formatTotal={(row, total) => `${formatCount(total)} pts`}
              emptyTitle="No advisor activity."
              emptyDetail="No advisor productivity rows were returned for the current filters."
              testId="advisor-productivity-chart"
            />
            {advisorProductivity.length ? <RawData label="advisors" value={advisorProductivity} /> : null}
          </div>
        </PageSection>

        <PageSection title="Export usage" subtitle="Export volume by status and by requesting advisor.">
          {exportUsage && (exportTotal || exportStatuses.length || exportAdvisorRows.length) ? (
            <div className="compact-stack">
              <p className="chart-summary">
                {formatCount(exportTotal)} export{exportTotal === 1 ? '' : 's'} requested for the current filter set.
              </p>
              <StatTrendRow
                testId="export-usage-stats"
                stats={[
                  { key: 'total', label: 'Total exports', value: formatCount(exportTotal) },
                  ...exportStatuses.map(([status, count]) => ({
                    key: status,
                    label: humanizeKey(status),
                    value: formatCount(count),
                    toneColor: exportStatusColor(status)
                  }))
                ]}
                distribution={
                  exportStatuses.length
                    ? {
                        title: 'Exports by status',
                        description: 'Distribution of export jobs across statuses for the current filter set.',
                        segments: exportStatuses.map(([status, count]) => ({
                          key: status,
                          label: humanizeKey(status),
                          value: count,
                          color: exportStatusColor(status)
                        }))
                      }
                    : undefined
                }
              />
              <HorizontalBarChart
                title="Exports by advisor"
                description="Number of export jobs requested by each advisor."
                rows={exportAdvisorRows}
                color="var(--chart-cat-5)"
                valueHeader="Exports requested"
                emptyTitle="No per-advisor export data."
                emptyDetail="No export jobs were attributed to advisors for the current filters."
                testId="export-advisor-chart"
              />
              <RawData label="exports" value={exportUsage} />
            </div>
          ) : (
            <EmptyState
              title="No export usage yet."
              detail="Export volume will chart here once export jobs are requested."
            />
          )}
        </PageSection>
      </div>
    </div>
  )
}
