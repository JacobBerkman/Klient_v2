import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { Household, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import { Card, ErrorState, LoadingState, PageSection } from '../components/ui'

export const handle = {
  title: 'Households',
  subtitle: 'Real list page for grouped relationships, member management, and spouse linking.',
  breadcrumb: 'Households'
}

interface HouseholdsPageData {
  households: Household[]
  clients: Profile[]
}

export function Component() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [form, setForm] = useState({ name: '', primaryClientId: '' })
  const [statusMessage, setStatusMessage] = useState('')

  const { data, error, loading } = useAsync<HouseholdsPageData>(
    async () => {
      const [households, clients] = await Promise.all([
        api.get<Household[]>(routes.households()),
        api.get<Profile[]>(routes.profiles({ kind: 'client' }))
      ])
      return { households, clients }
    },
    [refreshKey]
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
    <div className="split-grid">
      <Card className="section-card">
        <h3>Create household</h3>
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            <span>Household name</span>
            <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
          </label>
          <label>
            <span>Primary client</span>
            <select value={form.primaryClientId} onChange={(event) => setForm((current) => ({ ...current, primaryClientId: event.target.value }))} required>
              <option value="">Select a client</option>
              {data.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {profileName(client)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
            Create household
          </button>
        </form>
        <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
          {statusMessage || 'Create and relationship-linking flows now live on the households routes.'}
        </p>
      </Card>

      <PageSection title="Household list" subtitle="Open the dedicated detail route for member and spouse management.">
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Primary client</th>
                <th>Members</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.households.map((household) => (
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
          </table>
        </div>
      </PageSection>
    </div>
  )
}
