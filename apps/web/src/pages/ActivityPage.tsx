import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDate, formatDateTime } from '../lib/format'
import { useAuth } from '../app/auth'
import type { ActivityEvent, ActivityPayload } from '../lib/types'
import { EmptyState, ErrorState, LoadingState, PageHero, PageSection, StatusBadge, Toolbar } from '../components/ui'

export const handle = {
  title: 'Activity',
  subtitle: 'Firm-wide feed of everything that happened across profiles, pipeline, forms, documents, and access.',
  breadcrumb: 'Activity'
}

// Mirrors the server-side ACTIVITY_CATEGORIES filter options (labels only — the
// action-prefix mapping stays server-side in modules/activity/categories.mjs).
const CATEGORY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All categories' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'forms', label: 'Forms & templates' },
  { id: 'documents', label: 'Documents' },
  { id: 'auth', label: 'Auth & access' },
  { id: 'system', label: 'System' }
]

const CATEGORY_LABELS: Record<string, string> = CATEGORY_OPTIONS.reduce(
  (acc, option) => {
    if (option.id) acc[option.id] = option.label
    return acc
  },
  { other: 'Other' } as Record<string, string>
)

interface ActorOption {
  id: string
  label: string
}

// Entity link resolution lives here (one place): only entity types with a real
// detail route are linked; everything else renders as plain text.
function entityLink(event: ActivityEvent): string | null {
  if (!event.entityId) return null
  switch (event.entityType) {
    case 'profile':
      return `/profiles/${event.entityId}`
    case 'household':
      return `/households/${event.entityId}`
    case 'form_submission':
      return `/forms/submissions/${event.entityId}`
    case 'template_aggregate':
      return `/templates/${event.entityId}`
    default:
      return null
  }
}

function groupByDay(events: ActivityEvent[]) {
  const groups: Array<{ day: string; label: string; events: ActivityEvent[] }> = []
  const index = new Map<string, number>()
  for (const event of events) {
    const day = event.timestamp ? new Date(event.timestamp).toDateString() : 'Unknown date'
    if (!index.has(day)) {
      index.set(day, groups.length)
      groups.push({ day, label: event.timestamp ? formatDate(event.timestamp) : 'Unknown date', events: [] })
    }
    groups[index.get(day) as number].events.push(event)
  }
  return groups
}

export function Component() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [category, setCategory] = useState('')
  const [actorId, setActorId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const [actors, setActors] = useState<ActorOption[]>([])

  // Actor filter is populated from the admin-only users lookup route; advisors
  // and read-only users do not get the /api/users route, so they see no actor
  // filter at all.
  useEffect(() => {
    if (!isAdmin) return
    let active = true
    void api
      .get<{ users: ActorOption[] }>(routes.users({ mode: 'lookup', includeSelf: true, limit: 50 }))
      .then((payload) => {
        if (active) setActors(payload.users || [])
      })
      .catch(() => {
        if (active) setActors([])
      })
    return () => {
      active = false
    }
  }, [isAdmin])

  const load = useCallback(
    (cursor: string | null) => {
      const query = {
        category: category || undefined,
        actorId: actorId || undefined,
        from: from || undefined,
        // Include the whole end day by pushing the upper bound to end-of-day.
        to: to ? `${to}T23:59:59.999Z` : undefined,
        cursor: cursor || undefined
      }
      if (cursor) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      return api
        .get<ActivityPayload>(routes.activity(query))
        .then((payload) => {
          setEvents((current) => (cursor ? [...current, ...payload.events] : payload.events))
          setNextCursor(payload.nextCursor)
          setError(null)
        })
        .catch((err: Error) => {
          if (!cursor) setEvents([])
          setError(err)
        })
        .finally(() => {
          setLoading(false)
          setLoadingMore(false)
        })
    },
    [category, actorId, from, to]
  )

  // Reload from the top whenever a filter changes.
  useEffect(() => {
    void load(null)
  }, [load])

  const groups = useMemo(() => groupByDay(events), [events])

  return (
    <div className="stack">
      <PageHero
        eyebrow="Activity"
        title="Everything happening across the firm"
        subtitle="A single chronological feed of profile, pipeline, form, document, and access events — filter by category, actor, or date."
        meta={<StatusBadge status={`${events.length} loaded`} />}
      />
      <PageSection title="Activity feed" subtitle="Newest first, grouped by day.">
        <Toolbar label="Activity filters" align="start">
          <label className="field">
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.id || 'all'} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {isAdmin ? (
            <label className="field">
              <span>Actor</span>
              <select value={actorId} onChange={(event) => setActorId(event.target.value)}>
                <option value="">All actors</option>
                {actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span>From</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </Toolbar>

        {loading ? (
          <LoadingState label="Loading activity" />
        ) : error ? (
          <ErrorState title="Activity failed to load." detail={error.message} />
        ) : events.length === 0 ? (
          <EmptyState title="No activity matches." detail="Try a broader category or widen the date range." />
        ) : (
          <div className="activity-feed">
            {groups.map((group) => (
              <section key={group.day} className="activity-day">
                <h3 className="activity-day-label">{group.label}</h3>
                <ol className="activity-list">
                  {group.events.map((event) => {
                    const link = entityLink(event)
                    return (
                      <li key={event.id} className="activity-item">
                        <div className="activity-item-main">
                          <span className="activity-summary">{event.summary}</span>
                          <span className="activity-category">{CATEGORY_LABELS[event.category] || event.category}</span>
                        </div>
                        <div className="activity-item-meta">
                          <span className="activity-actor">{event.actorName}</span>
                          <span className="activity-time">{formatDateTime(event.timestamp)}</span>
                          {link ? (
                            <Link className="activity-link" to={link}>
                              View {event.entityType}
                            </Link>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </section>
            ))}
            {nextCursor ? (
              <div className="activity-load-more">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={loadingMore}
                  onClick={() => void load(nextCursor)}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </PageSection>
    </div>
  )
}
