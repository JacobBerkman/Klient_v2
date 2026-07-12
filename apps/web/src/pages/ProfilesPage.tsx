import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime, humanizeKey, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { CustomFieldSchemaPayload, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  ActionPanel,
  ButtonLink,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  LoadingState,
  PageHero,
  PageSection,
  SegmentedControl,
  StatusBadge,
  Toolbar
} from '../components/ui'

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
  const [showArchived, setShowArchived] = useState(false)
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

  const { data, error, loading } = useAsync<ProfilesPageData>(async () => {
    const [profiles, schema] = await Promise.all([
      api.get<Profile[]>(routes.profiles(showArchived ? { includeArchived: 1 } : {})),
      api.get<CustomFieldSchemaPayload>(routes.profileCustomFieldSchema()).catch(() => ({ fields: [] }))
    ])
    return { profiles, schema }
  }, [refreshKey, showArchived])

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
      <PageHero
        eyebrow="Client directory"
        title="Profiles are the system of record"
        subtitle="Search, create, and route into dedicated detail pages for editing, notes, household linkage, forms, and exports."
        actions={
          <>
            <ButtonLink variant="primary" to="/pipeline">
              Open pipeline
            </ButtonLink>
            <ButtonLink to="/households">Manage households</ButtonLink>
          </>
        }
      />
      <PageSection
        title="Directory"
        subtitle="Use route-based detail views for editing while keeping the list page fast and focused."
        action={
          <SegmentedControl
            label="Profiles panel"
            value={panel}
            options={[
              { label: 'Profiles', value: 'directory' },
              { label: 'Custom fields', value: 'schema' }
            ]}
            onChange={(value) => setSearchParams({ panel: value })}
          />
        }
      >
        {panel === 'schema' ? (
          <>
            <InlineNotice tone="info">
              The schema panel now lives on a real routed screen instead of falling through the global shell.
            </InlineNotice>
            {data.schema.fields.length ? (
              <DataTable caption="Custom profile field schema">
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
                      <td>
                        {Object.entries(field.metadata || {})
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(' / ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : (
              <EmptyState title="No custom fields yet." detail="Schema fields will appear here when configured." />
            )}
          </>
        ) : (
          <>
            <Toolbar label="Profile filters">
              <input
                aria-label="Search profiles"
                placeholder="Search by name, email, or phone"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                aria-label="Filter profile type"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}
              >
                <option value="all">All kinds</option>
                <option value="prospect">Prospects</option>
                <option value="client">Clients</option>
              </select>
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                Show archived
              </label>
            </Toolbar>

            <div className="split-grid">
              <ActionPanel
                title="Create profile"
                subtitle="Add the person here, then manage richer details on their profile route."
              >
                <form className="form-grid two-up" onSubmit={handleCreateProfile}>
                  <Field label="Kind">
                    <select
                      value={form.kind}
                      onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}
                    >
                      <option value="prospect">Prospect</option>
                      <option value="client">Client</option>
                    </select>
                  </Field>
                  <Field label="First name">
                    <input
                      value={form.firstName}
                      onChange={(event) => setForm((current) => ({ ...current, firstName: event.target.value }))}
                      required
                    />
                  </Field>
                  <Field label="Last name">
                    <input
                      value={form.lastName}
                      onChange={(event) => setForm((current) => ({ ...current, lastName: event.target.value }))}
                      required
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      value={form.email}
                      onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      value={form.phone}
                      onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                    />
                  </Field>
                  <Field label="Initial stage" hint="Optional stage id for seeded/imported work.">
                    <input
                      value={form.stage}
                      onChange={(event) => setForm((current) => ({ ...current, stage: event.target.value }))}
                    />
                  </Field>
                  <button type="submit" disabled={creating || !hasGuard(user, 'canWriteProfiles')}>
                    {creating ? 'Creating...' : 'Create profile'}
                  </button>
                </form>
                <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
                  {statusMessage || 'Global create forms have been relocated into the relevant routed page.'}
                </p>
              </ActionPanel>

              <ActionPanel
                title="Profile list"
                subtitle={`${visibleProfiles.length} profiles match the current filters.`}
              >
                {visibleProfiles.length ? (
                  <DataTable caption="Profile directory results">
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
                            <StatusBadge status={profile.kind} />
                            {profile.archivedAt ? <StatusBadge status="Archived" /> : null}
                          </td>
                          <td>{profile.stage || 'Unassigned'}</td>
                          <td>{profile.householdId || 'Unlinked'}</td>
                          <td>{formatDateTime(profile.updatedAt || profile.createdAt)}</td>
                          <td>
                            <Link
                              className="text-link"
                              data-testid={`profile-link-${profile.id}`}
                              to={`/profiles/${profile.id}`}
                            >
                              Open detail
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                ) : (
                  <EmptyState
                    title="No profiles match."
                    detail="Adjust the search or profile type filter, or create a new profile."
                  />
                )}
              </ActionPanel>
            </div>
          </>
        )}
      </PageSection>
    </div>
  )
}
