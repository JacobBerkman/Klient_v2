import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { householdRoleLabel, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { Household, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import { Card, ErrorState, LoadingState, PageSection } from '../components/ui'

export const handle = {
  title: ({ householdId }: Record<string, string | undefined>) => `Household ${householdId || ''}`.trim(),
  subtitle: 'Dedicated member, spouse, and relationship management without falling back to the shell.',
  breadcrumb: 'Household detail'
}

interface HouseholdDetailData {
  households: Household[]
  clients: Profile[]
}

export function Component() {
  const { householdId = '' } = useParams()
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [memberId, setMemberId] = useState('')
  const [memberRole, setMemberRole] = useState('member')
  const [spouseId, setSpouseId] = useState('')
  const [spouseForm, setSpouseForm] = useState({ firstName: '', lastName: '', email: '' })

  const { data, error, loading } = useAsync<HouseholdDetailData>(
    async () => {
      const [households, clients] = await Promise.all([
        api.get<Household[]>(routes.households()),
        api.get<Profile[]>(routes.profiles({ kind: 'client' }))
      ])
      return { households, clients }
    },
    [householdId, refreshKey]
  )

  if (loading) return <LoadingState label="Loading household" />
  if (error || !data) return <ErrorState title="Household detail failed to load." detail={error?.message} />

  const household = data.households.find((entry) => entry.id === householdId)
  if (!household) return <ErrorState title="Household not found." detail="The requested household is missing from the canonical API response." />

  const profileById = new Map(data.clients.map((client) => [client.id, client]))
  const availableMembers = data.clients.filter((client) => client.householdId !== householdId)
  const primaryProfile = profileById.get(household.primaryClientId)

  async function refreshAfter(action: Promise<unknown>, message: string) {
    try {
      await action
      setStatusMessage(message)
      setRefreshKey((value) => value + 1)
    } catch (actionError) {
      setStatusMessage(actionError instanceof Error ? actionError.message : 'Request failed.')
    }
  }

  return (
    <div className="stack">
      <PageSection title={household.name} subtitle={`Primary client ${profileName(primaryProfile)} / ${household.members.length} members`}>
        <div className="split-grid">
          <Card className="section-card">
            <h3>Members</h3>
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {household.members.map((member) => (
                    <tr key={`${member.clientId}-${member.role}`}>
                      <td>{profileName(profileById.get(member.clientId))}</td>
                      <td>{householdRoleLabel(member)}</td>
                      <td>
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={!hasGuard(user, 'canWriteHouseholds')}
                          onClick={() =>
                            void refreshAfter(
                              api.delete(routes.householdMembers(household.id), { clientId: member.clientId }),
                              'Member removed.'
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="section-card">
            <h3>Add member</h3>
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault()
                void refreshAfter(
                  api.post(routes.householdMembers(household.id), { clientId: memberId, role: memberRole }),
                  'Member added.'
                )
              }}
            >
              <label>
                <span>Client</span>
                <select value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
                  <option value="">Select a client</option>
                  {availableMembers.map((client) => (
                    <option key={client.id} value={client.id}>
                      {profileName(client)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Role</span>
                <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
                  <option value="member">Member</option>
                  <option value="dependent">Dependent</option>
                  <option value="spouse">Spouse</option>
                </select>
              </label>
              <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
                Add member
              </button>
            </form>
          </Card>
        </div>
      </PageSection>

      <div className="split-grid">
        <Card className="section-card">
          <h3>Link existing spouse</h3>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              void refreshAfter(
                api.post(routes.householdLinkSpouse(), {
                  primaryClientId: household.primaryClientId,
                  spouseClientId: spouseId
                }),
                'Existing spouse linked.'
              )
            }}
          >
            <label>
              <span>Client</span>
              <select value={spouseId} onChange={(event) => setSpouseId(event.target.value)} required>
                <option value="">Select an existing client</option>
                {availableMembers.map((client) => (
                  <option key={client.id} value={client.id}>
                    {profileName(client)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
              Link spouse
            </button>
          </form>
        </Card>

        <Card className="section-card">
          <h3>Create spouse</h3>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              void refreshAfter(
                api.post(routes.householdCreateSpouse(), {
                  primaryClientId: household.primaryClientId,
                  spouse: spouseForm
                }),
                'Spouse created and linked.'
              )
            }}
          >
            <label>
              <span>First name</span>
              <input value={spouseForm.firstName} onChange={(event) => setSpouseForm((current) => ({ ...current, firstName: event.target.value }))} required />
            </label>
            <label>
              <span>Last name</span>
              <input value={spouseForm.lastName} onChange={(event) => setSpouseForm((current) => ({ ...current, lastName: event.target.value }))} required />
            </label>
            <label>
              <span>Email</span>
              <input type="email" value={spouseForm.email} onChange={(event) => setSpouseForm((current) => ({ ...current, email: event.target.value }))} />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
              Create spouse
            </button>
          </form>
        </Card>
      </div>

      <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
        {statusMessage || 'Create, add, split, and spouse-link flows have been relocated here from the old shell.'}
      </p>
    </div>
  )
}
