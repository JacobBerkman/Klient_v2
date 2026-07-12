import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { householdRoleLabel, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { Household, Profile } from '../lib/types'
import { useAuth } from '../app/auth'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/toast'
import {
  ActionPanel,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHero,
  PageSection,
  StatusBadge
} from '../components/ui'

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
  const toast = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [confirmingRemoveClientId, setConfirmingRemoveClientId] = useState('')
  const [removingMember, setRemovingMember] = useState(false)
  const [memberId, setMemberId] = useState('')
  const [memberRole, setMemberRole] = useState('member')
  const [spouseId, setSpouseId] = useState('')
  const [spouseForm, setSpouseForm] = useState({ firstName: '', lastName: '', email: '' })

  const { data, error, loading } = useAsync<HouseholdDetailData>(async () => {
    const [households, clients] = await Promise.all([
      api.get<Household[]>(routes.households()),
      api.get<Profile[]>(routes.profiles({ kind: 'client' }))
    ])
    return { households, clients }
  }, [householdId, refreshKey])

  if (loading) return <LoadingState label="Loading household" />
  if (error || !data) return <ErrorState title="Household detail failed to load." detail={error?.message} />

  const household = data.households.find((entry) => entry.id === householdId)
  if (!household)
    return (
      <ErrorState
        title="Household not found."
        detail="The requested household is missing from the canonical API response."
      />
    )

  const profileById = new Map(data.clients.map((client) => [client.id, client]))
  const availableMembers = data.clients.filter((client) => client.householdId !== householdId)
  const primaryProfile = profileById.get(household.primaryClientId)

  async function refreshAfter(action: Promise<unknown>, message: string) {
    try {
      await action
      toast.success(message)
      setRefreshKey((value) => value + 1)
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : 'Request failed.')
    }
  }

  async function handleRemoveMember(clientId: string) {
    if (!household) return
    setRemovingMember(true)
    try {
      await refreshAfter(api.delete(routes.householdMembers(household.id), { clientId }), 'Member removed.')
    } finally {
      setConfirmingRemoveClientId('')
      setRemovingMember(false)
    }
  }

  return (
    <div className="stack">
      <PageHero
        eyebrow="Household workspace"
        title={household.name}
        subtitle="Manage the relationship graph here instead of scattering spouse and member flows across the shell."
        meta={
          <>
            <StatusBadge status={`${household.members.length} members`} />
            <StatusBadge status={`Primary ${profileName(primaryProfile)}`} />
          </>
        }
      />
      <PageSection
        title={household.name}
        subtitle={`Primary client ${profileName(primaryProfile)} / ${household.members.length} members`}
      >
        <div className="split-grid">
          <ActionPanel title="Members" subtitle="Current household composition and role labels.">
            {household.members.length ? (
              <DataTable caption="Household members">
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
                          onClick={() => setConfirmingRemoveClientId(member.clientId)}
                        >
                          Remove
                        </button>
                        <ConfirmDialog
                          open={confirmingRemoveClientId === member.clientId}
                          title="Remove household member?"
                          description={`Removing ${profileName(profileById.get(member.clientId))} detaches them from ${household.name}. Their profile is unaffected and can be re-added later.`}
                          confirmLabel="Confirm remove"
                          tone="danger"
                          busy={removingMember}
                          onConfirm={() => void handleRemoveMember(member.clientId)}
                          onCancel={() => setConfirmingRemoveClientId('')}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : (
              <EmptyState title="No members linked." detail="Add a client from the panel beside this list." />
            )}
          </ActionPanel>

          <ActionPanel title="Add member" subtitle="Attach an existing client and assign their household role.">
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
              <Field label="Client">
                <select value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
                  <option value="">Select a client</option>
                  {availableMembers.map((client) => (
                    <option key={client.id} value={client.id}>
                      {profileName(client)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role">
                <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
                  <option value="member">Member</option>
                  <option value="dependent">Dependent</option>
                  <option value="spouse">Spouse</option>
                </select>
              </Field>
              <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
                Add member
              </button>
            </form>
          </ActionPanel>
        </div>
      </PageSection>

      <div className="split-grid">
        <ActionPanel title="Link existing spouse" subtitle="Use this when both clients already exist.">
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
            <Field label="Client">
              <select value={spouseId} onChange={(event) => setSpouseId(event.target.value)} required>
                <option value="">Select an existing client</option>
                {availableMembers.map((client) => (
                  <option key={client.id} value={client.id}>
                    {profileName(client)}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
              Link spouse
            </button>
          </form>
        </ActionPanel>

        <ActionPanel
          title="Create spouse"
          subtitle="Create the spouse profile and link it to this household in one flow."
        >
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
            <Field label="First name">
              <input
                value={spouseForm.firstName}
                onChange={(event) => setSpouseForm((current) => ({ ...current, firstName: event.target.value }))}
                required
              />
            </Field>
            <Field label="Last name">
              <input
                value={spouseForm.lastName}
                onChange={(event) => setSpouseForm((current) => ({ ...current, lastName: event.target.value }))}
                required
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={spouseForm.email}
                onChange={(event) => setSpouseForm((current) => ({ ...current, email: event.target.value }))}
              />
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canWriteHouseholds')}>
              Create spouse
            </button>
          </form>
        </ActionPanel>
      </div>

      <p className="muted">Create, add, split, and spouse-link flows have been relocated here from the old shell.</p>
    </div>
  )
}
