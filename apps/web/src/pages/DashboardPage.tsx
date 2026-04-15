import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { DashboardPayload } from '../lib/types'
import { Card, ErrorState, LoadingState, MetricCard, PageSection } from '../components/ui'

export const handle = {
  title: 'Dashboard',
  subtitle: 'Firm-level summary, recent activity, and shortcuts without mixing operational forms into the landing page.',
  breadcrumb: 'Dashboard'
}

export function Component() {
  const { data, error, loading } = useAsync<DashboardPayload>(() => api.get(routes.dashboard()), [])

  if (loading) return <LoadingState label="Loading dashboard" />
  if (error || !data) return <ErrorState title="Dashboard failed to load." detail={error?.message} />

  return (
    <div className="stack" data-testid="dashboard-page">
      <div className="metrics-grid">
        <MetricCard label="Total profiles" value={data.stats.totalProfiles} hint={`${data.stats.prospects} prospects / ${data.stats.clients} clients`} />
        <MetricCard label="Households" value={data.stats.households} hint="Linked relationship groups" />
        <MetricCard label="Forms" value={data.stats.forms} hint="Drafts and submissions" />
        <MetricCard label="Exports" value={data.stats.exports} hint="Queued and completed packages" />
      </div>

      <div className="cards-grid">
        <Card className="section-card">
          <p className="eyebrow">Shortcuts</p>
          <h3>Jump into active work</h3>
          <div className="compact-stack">
            <Link className="text-link" to="/pipeline">Open pipeline board</Link>
            <Link className="text-link" to="/profiles">Review profiles</Link>
            <Link className="text-link" to="/forms">Manage forms</Link>
            <Link className="text-link" to="/exports">Queue exports</Link>
          </div>
        </Card>

        <Card className="section-card">
          <p className="eyebrow">Firm</p>
          <h3>{data.firm?.name || 'Firm workspace'}</h3>
          <p className="muted">The dashboard now stays focused on signal and navigation instead of carrying every create workflow.</p>
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
            <p className="muted">No profiles yet.</p>
          )}
        </PageSection>

        <PageSection title="Recent activity" subtitle="Latest audit trail events flowing through the current backend.">
          <div className="table-shell">
            <table>
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
            </table>
          </div>
        </PageSection>
      </div>
    </div>
  )
}
