import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime, humanizeKey, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { CustomFieldSchemaPayload, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import { Badge, Card, ErrorState, InlineNotice, LoadingState, PageSection } from '../components/ui'

export const handle = {
  title: 'Profiles',
  subtitle: 'Search and filter prospects or clients, then handle editing on dedicated detail routes only.',
  breadcrumb: 'Profiles'
}

interface ProfilesPageData {
  profiles: Profile[]
  schema: CustomFieldSchemaPayload
}

export function Component() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [refreshKey, setRefreshKey] = useState(0)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | 'prospect' | 'client'>('all')
  const [statusMessage, setStatusMessage] = useState('')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    kind: 'prospect',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    stage: ''
  })

  const panel = searchParams.get('panel') || 'directory'

  const { data, error, loading } = useAsync<ProfilesPageData>(
    async () => {
      const [profiles, schema] = await Promise.all([
        api.get<Profile[]>(routes.profiles()),
        api.get<CustomFieldSchemaPayload>(routes.profileCustomFieldSchema()).catch(() => ({ fields: [] }))
      ])
      return { profiles, schema }
    },
    [refreshKey]
  )

  const visibleProfiles = useMemo(() => {
    if (!data) return []
    const token = search.trim().toLowerCase()
    return data.profiles.filter((profile) => {
      if (kindFilter !== 'all' && profile.kind !== kindFilter) return false
      if (!token) return true
      const haystack = `${profileName(profile)} ${profile.email || ''} ${profile.phone || ''}`.toLowerCase()
      return haystack.includes(token)
    })
  }, [data, kindFilter, search])

  async function handleCreateProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    setStatusMessage('')
    try {
      await api.post(routes.profiles(), {
        kind: form.kind,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email || undefined,
        phone: form.phone || undefined,
        ...(form.stage ? { stage: form.stage } : {})
      })
      setStatusMessage('Profile created.')
      setForm({
        kind: 'prospect',
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        stage: ''
      })
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Unable to create profile.')
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <LoadingState label="Loading profiles" />
  if (error || !data) return <ErrorState title="Profiles failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageSection
        title="Directory"
        subtitle="Use route-based detail views for editing while keeping the list page fast and focused."
        action={
          <div className="actions-row">
            <button
              type="button"
              className={panel === 'directory' ? 'secondary-button' : 'ghost-button'}
              onClick={() => setSearchParams({ panel: 'directory' })}
            >
              Profiles
            </button>
            <button
              type="button"
              className={panel === 'schema' ? 'secondary-button' : 'ghost-button'}
              onClick={() => setSearchParams({ panel: 'schema' })}
            >
              Custom fields
            </button>
          </div>
        }
      >
        {panel === 'schema' ? (
          <>
            <InlineNotice tone="info">The schema panel now lives on a real routed screen instead of falling through the global shell.</InlineNotice>
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Label</th>
                    <th>Type</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {data.schema.fields.map((field) => (
                    <tr key={field.key}>
                      <td>{field.key}</td>
                      <td>{field.label || humanizeKey(field.key)}</td>
                      <td>{field.type}</td>
                      <td>{Object.entries(field.metadata || {}).map(([key, value]) => `${key}: ${String(value)}`).join(' / ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="toolbar">
              <input aria-label="Search profiles" placeholder="Search by name, email, or phone" value={search} onChange={(event) => setSearch(event.target.value)} />
              <select aria-label="Filter profile type" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}>
                <option value="all">All kinds</option>
                <option value="prospect">Prospects</option>
                <option value="client">Clients</option>
              </select>
            </div>

            <div className="split-grid">
              <Card className="section-card">
                <h3>Create profile</h3>
                <form className="form-grid two-up" onSubmit={handleCreateProfile}>
                  <label>
                    <span>Kind</span>
                    <select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}>
                      <option value="prospect">Prospect</option>
                      <option value="client">Client</option>
                    </select>
                  </label>
                  <label>
                    <span>First name</span>
                    <input value={form.firstName} onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))} required />
                  </label>
                  <label>
                    <span>Last name</span>
                    <input value={form.lastName} onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))} required />
                  </label>
                  <label>
                    <span>Email</span>
                    <input type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
                  </label>
                  <label>
                    <span>Phone</span>
                    <input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} />
                  </label>
                  <label>
                    <span>Initial stage</span>
                    <input value={form.stage} onChange={(event) => setForm((current) => ({ ...current, stage: event.target.value }))} />
                  </label>
                  <button type="submit" disabled={creating || !hasGuard(user, 'canWriteProfiles')}>
                    {creating ? 'Creating...' : 'Create profile'}
                  </button>
                </form>
                <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
                  {statusMessage || 'Global create forms have been relocated into the relevant routed page.'}
                </p>
              </Card>

              <Card className="section-card">
                <h3>Profile list</h3>
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Kind</th>
                        <th>Stage</th>
                        <th>Household</th>
                        <th>Updated</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleProfiles.map((profile) => (
                        <tr key={profile.id}>
                          <td>
                            <strong>{profileName(profile)}</strong>
                            <div className="muted">{profile.email || 'No email on file'}</div>
                          </td>
                          <td>
                            <Badge tone={profile.kind === 'client' ? 'success' : 'info'}>{profile.kind}</Badge>
                          </td>
                          <td>{profile.stage || 'Unassigned'}</td>
                          <td>{profile.householdId || 'Unlinked'}</td>
                          <td>{formatDateTime(profile.updatedAt || profile.createdAt)}</td>
                          <td>
                            <Link className="text-link" data-testid={`profile-link-${profile.id}`} to={`/profiles/${profile.id}`}>
                              Open detail
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </>
        )}
      </PageSection>
    </div>
  )
}
