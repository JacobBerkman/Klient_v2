import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { Household, PageEnvelope, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  ActionPanel,
  ButtonLink,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHero,
  PageSection
} from '../components/ui'

export const handle = {
  title: 'Households',
  subtitle: 'Real list page for grouped relationships, member management, and spouse linking.',
  breadcrumb: 'Households'
}

const PAGE_SIZE = 50

interface HouseholdsPageData {
  page: PageEnvelope<Household>
  clients: Profile[]
}

export function Component() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [form, setForm] = useState({ name: '', primaryClientId: '' })
  const [statusMessage, setStatusMessage] = useState('')

  const { data, error, loading } = useAsync<HouseholdsPageData>(async () => {
    const [page, clients] = await Promise.all([
      api.get<PageEnvelope<Household>>(routes.households({ limit: PAGE_SIZE })),
      api.get<Profile[]>(routes.profiles({ kind: 'client' }))
    ])
    return { page, clients }
  }, [refreshKey])

  // "Load more" appends further pages below the freshly fetched first page.
  const [extraHouseholds, setExtraHouseholds] = useState<Household[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    setExtraHouseholds([])
    setNextCursor(data?.page.nextCursor ?? null)
  }, [data])

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await api.get<PageEnvelope<Household>>(routes.households({ limit: PAGE_SIZE, cursor: nextCursor }))
      setExtraHouseholds((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch (loadError) {
      setStatusMessage(loadError instanceof Error ? loadError.message : 'Unable to load more households.')
    } finally {
      setLoadingMore(false)
    }
  }

  const visibleHouseholds = useMemo(
    () => (data ? [...data.page.items, ...extraHouseholds] : []),
    [data, extraHouseholds]
  )

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await api.post(routes.households(), form)
      setStatusMessage('Household created.')
      setForm({ name: '', primaryClientId: '' })
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Household creation failed.')
    }
  }

  if (loading) return <LoadingState label="Loading households" />
  if (error || !data) return <ErrorState title="Households failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageHero
        eyebrow="Households"
        title="Keep relationships organized"
        subtitle="Create household groups and route into detail pages for member, spouse, and relationship management."
        actions={
          <ButtonLink variant="primary" to="/profiles">
            Review clients
          </ButtonLink>
        }
      />
      <div className="split-grid">
        <ActionPanel
          title="Create household"
          subtitle="Pick the primary client first; add spouses and members from the detail page."
        >
          <form className="form-grid" onSubmit={handleCreate}>
            <Field label="Household name">
              <input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </Field>
            <Field label="Primary client">
              <select
                value={form.primaryClientId}
                onChange={(event) => setForm((current) => ({ ...current, primaryClientId: event.target.value }))}
                required
              >
                <option value="">Select a client</option>
                {data.clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {profileName(client)}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
              Create household
            </button>
          </form>
          <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
            {statusMessage || 'Create and relationship-linking flows now live on the households routes.'}
          </p>
        </ActionPanel>

        <PageSection
          title="Household list"
          subtitle="Open the dedicated detail route for member and spouse management."
        >
          {visibleHouseholds.length ? (
            <DataTable caption="Household groups">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Primary client</th>
                  <th>Members</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleHouseholds.map((household) => (
                  <tr key={household.id}>
                    <td>{household.name}</td>
                    <td>{household.primaryClientId}</td>
                    <td>{household.members.length}</td>
                    <td>
                      <Link className="text-link" to={`/households/${household.id}`}>
                        Open household
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <EmptyState title="No households yet." detail="Create the first household from the panel on this page." />
          )}
          {nextCursor ? (
            <div className="activity-load-more">
              <button type="button" onClick={() => void handleLoadMore()} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            </div>
          ) : null}
        </PageSection>
      </div>
    </div>
  )
}
