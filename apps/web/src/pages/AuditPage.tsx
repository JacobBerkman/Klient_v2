import { useEffect, useMemo, useState } from 'react'
import { api, routes } from '../lib/client'
import { auditActor, formatDateTime } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { AuditEvent, PageEnvelope } from '../lib/types'
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHero,
  PageSection,
  StatusBadge,
  Toolbar
} from '../components/ui'

export const handle = {
  title: 'Audit',
  subtitle: 'Dedicated audit route for action history, entity traces, and security-sensitive event review.',
  breadcrumb: 'Audit'
}

const PAGE_SIZE = 200

export function Component() {
  const [search, setSearch] = useState('')
  // The audit read is clamped server-side, so the trail is walked with keyset
  // pages (limit/cursor => { items, nextCursor } envelope). Without this the
  // page could only ever see the newest 200 events and older compliance history
  // would be unreachable from the UI.
  const { data, error, loading } = useAsync<PageEnvelope<AuditEvent>>(
    () => api.get(routes.audit({ limit: PAGE_SIZE })),
    []
  )

  const [extraEvents, setExtraEvents] = useState<AuditEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  useEffect(() => {
    setExtraEvents([])
    setCursor(data?.nextCursor ?? null)
  }, [data])

  async function handleLoadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const page = await api.get<PageEnvelope<AuditEvent>>(routes.audit({ limit: PAGE_SIZE, cursor }))
      setExtraEvents((current) => [...current, ...page.items])
      setCursor(page.nextCursor)
    } catch (pageError) {
      setLoadMoreError(pageError instanceof Error ? pageError.message : 'Unable to load more audit events.')
    } finally {
      setLoadingMore(false)
    }
  }

  const allEvents = useMemo(() => (data ? [...data.items, ...extraEvents] : []), [data, extraEvents])

  const visibleEvents = useMemo(() => {
    const token = search.trim().toLowerCase()
    return allEvents.filter((event) => {
      if (!token) return true
      const haystack = [event.action, event.entityType, event.entityId, auditActor(event), JSON.stringify(event)]
        .join(' ')
        .toLowerCase()
      return haystack.includes(token)
    })
  }, [allEvents, search])

  if (loading) return <LoadingState label="Loading audit log" />
  if (error || !data) return <ErrorState title="Audit log failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageHero
        eyebrow="Audit"
        title="Trace what changed and who changed it"
        subtitle="Search the canonical audit stream by action, entity, actor, or payload without leaving the product UI."
        meta={<StatusBadge status={`${visibleEvents.length} visible events`} />}
      />
      <PageSection
        title="Audit trail"
        subtitle="Search the canonical event stream without falling back to the old shell."
      >
        <Toolbar label="Audit search">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search action, entity, actor, or payload"
          />
        </Toolbar>
        {visibleEvents.length ? (
          <DataTable caption="Audit events">
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
          </DataTable>
        ) : (
          <EmptyState
            title="No audit events match."
            detail={
              cursor
                ? 'Search covers the events loaded so far — load more to search deeper history.'
                : 'Try a broader search or wait for more activity.'
            }
          />
        )}
        {loadMoreError ? <p className="form-error">{loadMoreError}</p> : null}
        {cursor ? (
          <div className="table-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="audit-load-more"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore}
              aria-busy={loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
            <p className="muted">Search matches the {allEvents.length} events loaded so far.</p>
          </div>
        ) : null}
      </PageSection>
    </div>
  )
}
