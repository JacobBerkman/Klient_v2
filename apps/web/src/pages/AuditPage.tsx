import { useMemo, useState } from 'react'
import { api, routes } from '../lib/client'
import { auditActor, formatDateTime } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { AuditEvent } from '../lib/types'
import { EmptyState, ErrorState, LoadingState, PageSection } from '../components/ui'

export const handle = {
  title: 'Audit',
  subtitle: 'Dedicated audit route for action history, entity traces, and security-sensitive event review.',
  breadcrumb: 'Audit'
}

export function Component() {
  const [search, setSearch] = useState('')
  const { data, error, loading } = useAsync<AuditEvent[]>(() => api.get(routes.audit()), [])

  const visibleEvents = useMemo(() => {
    const token = search.trim().toLowerCase()
    if (!data) return []
    return data.filter((event) => {
      if (!token) return true
      const haystack = [event.action, event.entityType, event.entityId, auditActor(event), JSON.stringify(event)]
        .join(' ')
        .toLowerCase()
      return haystack.includes(token)
    })
  }, [data, search])

  if (loading) return <LoadingState label="Loading audit log" />
  if (error || !data) return <ErrorState title="Audit log failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageSection
        title="Audit trail"
        subtitle="Search the canonical event stream without falling back to the old shell."
      >
        <div className="toolbar">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search action, entity, actor, or payload"
          />
        </div>
        {visibleEvents.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Actor</th>
                  <th>When</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {visibleEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{event.action}</td>
                    <td>{[event.entityType, event.entityId].filter(Boolean).join(' / ') || 'system'}</td>
                    <td>{auditActor(event)}</td>
                    <td>{formatDateTime(event.timestamp)}</td>
                    <td>
                      <details>
                        <summary>Payload</summary>
                        <pre className="json-block">
                          {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No audit events match." detail="Try a broader search or wait for more activity." />
        )}
      </PageSection>
    </div>
  )
}
