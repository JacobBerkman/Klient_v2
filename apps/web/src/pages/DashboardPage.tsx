import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatCount, formatDateTime, formatPercent, humanizeKey, profileName } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { AnalyticsDashboardPayload, DashboardPayload, ProfileMeetingsPayload } from '../lib/types'
import { HorizontalBarChart } from '../components/charts'
import {
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHero,
  PageSection,
  StatGroup,
  StatusBadge
} from '../components/ui'

export const handle = {
  title: 'Dashboard',
  subtitle:
    'Firm-level summary, recent activity, and shortcuts without mixing operational forms into the landing page.',
  breadcrumb: 'Dashboard'
}

function FunnelOverview() {
  const { data, error, loading } = useAsync<AnalyticsDashboardPayload>(
    () => api.get(routes.analyticsDashboard()),
    []
  )

  if (loading) return null
  if (error || !data) {
    return (
      <PageSection title="Pipeline funnel" subtitle="Prospect counts by stage, from the analytics dashboard.">
        <EmptyState title="Funnel unavailable." detail={error?.message || 'Analytics data could not be loaded.'} />
      </PageSection>
    )
  }

  const stageLabels = new Map(
    (data.stageMetadata || []).map((stage) => [stage.id, stage.label || humanizeKey(stage.id)])
  )
  const funnel = data.funnel || []
  const totalProspects = funnel.reduce((sum, row) => sum + (row.count || 0), 0)
  const rows = funnel.map((row) => ({
    key: row.stage,
    label: stageLabels.get(row.stage) || humanizeKey(row.stage),
    value: row.count || 0,
    hover: `${stageLabels.get(row.stage) || humanizeKey(row.stage)}: ${formatCount(row.count || 0)} prospects (${formatPercent(row.conversionRate)} of the funnel)`
  }))

  return (
    <PageSection
      title="Pipeline funnel"
      subtitle="Prospect counts by stage, from the analytics dashboard."
      action={
        <Link className="text-link" to="/analytics">
          Open analytics
        </Link>
      }
    >
      <div className="chart-block">
        {totalProspects ? (
          <p className="chart-summary">{formatCount(totalProspects)} prospects currently in the pipeline.</p>
        ) : null}
        <HorizontalBarChart
          title="Pipeline funnel"
          description="Number of prospects currently sitting in each pipeline stage."
          rows={rows}
          color="var(--chart-cat-1)"
          valueHeader="Prospects"
          emptyTitle="No prospects in the funnel yet."
          emptyDetail="Add prospects from Profiles to see stage-by-stage movement here."
          testId="dashboard-funnel-chart"
        />
      </div>
    </PageSection>
  )
}

function UpcomingMeetings() {
  const { data, error, loading } = useAsync<ProfileMeetingsPayload>(
    () => api.get(routes.meetingsUpcoming({ windowDays: 14 })),
    []
  )

  if (loading || error || !data) return null
  const meetings = data.meetings || []

  return (
    <PageSection
      title="Upcoming meetings"
      subtitle="Meetings scheduled across the firm in the next 14 days."
    >
      {meetings.length ? (
        <DataTable caption="Upcoming meetings (next 14 days)">
          <thead>
            <tr>
              <th>When</th>
              <th>Profile</th>
              <th>Type</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((meeting) => (
              <tr key={meeting.id}>
                <td>{meeting.scheduledAt ? formatDateTime(meeting.scheduledAt) : 'Unscheduled'}</td>
                <td>
                  {meeting.profileName ? (
                    <Link className="text-link" to={`/profiles/${meeting.profileId}`}>
                      {meeting.profileName}
                    </Link>
                  ) : (
                    meeting.profileId
                  )}
                </td>
                <td>
                  <span className="role-pill">{meeting.meetingType || 'other'}</span>
                </td>
                <td>{meeting.notes || '-'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <EmptyState
          title="No upcoming meetings."
          detail="Log a meeting with a future date on any profile to see it here."
        />
      )}
    </PageSection>
  )
}

export function Component() {
  const { data, error, loading } = useAsync<DashboardPayload>(() => api.get(routes.dashboard()), [])

  if (loading) return <LoadingState label="Loading dashboard" />
  if (error || !data) return <ErrorState title="Dashboard failed to load." detail={error?.message} />

  return (
    <div className="stack" data-testid="dashboard-page">
      <PageHero
        eyebrow="Firm overview"
        title="Your advisory command center"
        subtitle="A focused landing page for the work that needs attention next, with creation flows moved into the right routed screens."
        actions={
          <>
            <ButtonLink variant="primary" to="/pipeline">
              Open pipeline
            </ButtonLink>
            <ButtonLink to="/profiles">Create or review profiles</ButtonLink>
          </>
        }
        meta={
          <>
            <StatusBadge status={`${data.stats.prospects} prospects`} />
            <StatusBadge status={`${data.stats.clients} clients`} />
          </>
        }
      />

      <StatGroup>
        <MetricCard
          label="Total profiles"
          value={data.stats.totalProfiles}
          hint={`${data.stats.prospects} prospects / ${data.stats.clients} clients`}
        />
        <MetricCard label="Households" value={data.stats.households} hint="Linked relationship groups" />
        <MetricCard label="Forms" value={data.stats.forms} hint="Drafts and submissions" />
        <MetricCard label="Exports" value={data.stats.exports} hint="Queued and completed packages" />
      </StatGroup>

      <FunnelOverview />

      <UpcomingMeetings />

      <div className="cards-grid">
        <Card className="section-card">
          <p className="eyebrow">Shortcuts</p>
          <h3>Jump into active work</h3>
          <div className="actions-row">
            <ButtonLink to="/pipeline">Pipeline board</ButtonLink>
            <ButtonLink to="/profiles">Profiles</ButtonLink>
            <ButtonLink to="/forms">Forms</ButtonLink>
            <ButtonLink to="/exports">Exports</ButtonLink>
          </div>
        </Card>

        <Card className="section-card">
          <p className="eyebrow">Firm</p>
          <h3>{data.firm?.name || 'Firm workspace'}</h3>
          <p className="muted">
            The dashboard now stays focused on signal and navigation instead of carrying every create workflow.
          </p>
        </Card>
      </div>

      <div className="split-grid">
        <PageSection title="Recent profiles" subtitle="Most recently touched people and households.">
          {data.recentProfiles.length ? (
            <div className="cards-grid">
              {data.recentProfiles.map((profile) => (
                <Card key={profile.id} className="section-card">
                  <div className="row-between">
                    <strong>{profileName(profile)}</strong>
                    <span className="role-pill">{profile.kind}</span>
                  </div>
                  <p className="muted">{profile.email || 'No email on file'}</p>
                  <p className="muted">Updated {formatDateTime(profile.updatedAt || profile.createdAt)}</p>
                  <Link className="text-link" to={`/profiles/${profile.id}`}>
                    Open profile
                  </Link>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No profiles yet."
              detail="Add a prospect or client from Profiles to start filling the workspace."
              action={<ButtonLink to="/profiles">Open profiles</ButtonLink>}
            />
          )}
        </PageSection>

        <PageSection title="Recent activity" subtitle="Latest audit trail events flowing through the current backend.">
          {data.recentAuditEvents.length ? (
            <DataTable caption="Recent firm activity">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAuditEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{event.action}</td>
                    <td>{[event.entityType, event.entityId].filter(Boolean).join(' / ') || 'system'}</td>
                    <td>{formatDateTime(event.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <EmptyState title="No recent activity." detail="Audit events will appear here as the workspace changes." />
          )}
        </PageSection>
      </div>
    </div>
  )
}
