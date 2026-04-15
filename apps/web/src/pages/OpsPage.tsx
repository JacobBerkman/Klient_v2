import { api, routes } from '../lib/client'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { DiagnosticsPayload, ExportRuntimePayload, HealthPayload } from '../lib/types'
import { useAuth } from '../app/auth'
import { EmptyState, ErrorState, LoadingState, MetricCard, PageSection } from '../components/ui'

export const handle = {
  title: 'Ops',
  subtitle: 'Admin diagnostics, queue health, runtime health, and release-readiness links on a real route.',
  breadcrumb: 'Ops'
}

interface OpsPageData {
  diagnostics: DiagnosticsPayload
  exportRuntime: ExportRuntimePayload
  ready: HealthPayload
  health: HealthPayload
}

export function Component() {
  const { user } = useAuth()
  const canReadDiagnostics = hasGuard(user, 'canReadDiagnostics')

  const { data, error, loading } = useAsync<OpsPageData>(
    async () => {
      const [diagnostics, exportRuntime, ready, health] = await Promise.all([
        api.get<DiagnosticsPayload>(routes.diagnostics()),
        api.get<ExportRuntimePayload>(routes.exportRuntime()),
        api.get<HealthPayload>(routes.ready()),
        api.get<HealthPayload>(routes.health())
      ])
      return { diagnostics, exportRuntime, ready, health }
    },
    []
  )

  if (!canReadDiagnostics) {
    return <ErrorState title="Admin access required." detail="This route keeps ops visibility role-scoped and does not expose diagnostics to non-admin roles." />
  }
  if (loading) return <LoadingState label="Loading operations" />
  if (error || !data) return <ErrorState title="Operations data failed to load." detail={error?.message} />

  const readyChecks = Object.entries(data.ready.checks || {})

  return (
    <div className="stack">
      <div className="metrics-grid">
        <MetricCard label="Ready" value={data.ready.ready ? 'Yes' : 'No'} hint="Release readiness endpoint" />
        <MetricCard label="Health" value={String(data.health.status || 'unknown')} hint="Service liveness" />
        <MetricCard label="Queue stalled" value={String(data.exportRuntime.workerStatus?.stalled || 0)} hint="Export worker stall count" />
        <MetricCard label="Recent failures" value={data.exportRuntime.recentFailures?.length || 0} hint="Latest export runtime failures" />
      </div>

      <div className="split-grid">
        <PageSection title="Runtime checks" subtitle="Readiness and health checks now have a dedicated admin view.">
          {readyChecks.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {readyChecks.map(([key, value]) => (
                    <tr key={key}>
                      <td>{key}</td>
                      <td>{value ? 'pass' : 'fail'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No readiness checks." detail="The ready endpoint did not return any check entries." />
          )}
        </PageSection>

        <PageSection title="Export runtime" subtitle="Queue status, leases, and failures surface directly on the admin route.">
          <div className="compact-stack">
            <pre className="json-block">{JSON.stringify(data.exportRuntime.workerStatus || {}, null, 2)}</pre>
            <pre className="json-block">{JSON.stringify(data.exportRuntime.queueStatus || {}, null, 2)}</pre>
          </div>
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection title="Diagnostics" subtitle="Security and storage diagnostics stay on the current backend contract.">
          <pre className="json-block">{JSON.stringify(data.diagnostics.data || {}, null, 2)}</pre>
        </PageSection>

        <PageSection title="Release links" subtitle="Launch-readiness endpoints remain easy to access from one place.">
          <div className="compact-stack">
            <a className="text-link" href="/ready">
              Open /ready
            </a>
            <a className="text-link" href="/health">
              Open /health
            </a>
            <a className="text-link" href="/system/status">
              Open /system/status
            </a>
            <a className="text-link" href="/api/ops/diagnostics">
              Open /api/ops/diagnostics
            </a>
            <a className="text-link" href="/api/ops/export-runtime">
              Open /api/ops/export-runtime
            </a>
          </div>
        </PageSection>
      </div>
    </div>
  )
}
