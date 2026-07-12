import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, profilesApi, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { ProfileDetailPayload } from '../lib/types'
import { useAuth } from '../app/auth'
import { ProfileTagsEditor } from '../components/ProfileTags'
import {
  ActionPanel,
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  KeyValueList,
  LoadingState,
  PageHero,
  PageSection,
  StatusBadge,
  Timeline
} from '../components/ui'

export const handle = {
  title: ({ profileId }: Record<string, string | undefined>) => `Profile ${profileId || ''}`.trim(),
  subtitle: 'Dedicated detail route with inline editing, notes, stage history, sensitive data, and household context.',
  breadcrumb: 'Profile detail'
}

export function Component() {
  const { profileId = '' } = useParams()
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [confirmingConvert, setConfirmingConvert] = useState(false)
  const [converting, setConverting] = useState(false)

  const { data, error, loading } = useAsync<ProfileDetailPayload>(
    () => api.get(routes.profileDetail(profileId)),
    [profileId, refreshKey]
  )
  const sensitive = useAsync<Record<string, unknown>>(
    () => api.get(routes.profileSensitive(profileId)),
    [profileId, refreshKey]
  )

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!data) return
    const form = new FormData(event.currentTarget)
    const payload = {
      firstName: String(form.get('firstName') || ''),
      lastName: String(form.get('lastName') || ''),
      email: String(form.get('email') || ''),
      phone: String(form.get('phone') || ''),
      expectedUpdatedAt: data.profile.updatedAt
    }
    try {
      await api.patch(routes.profileDetail(profileId), payload)
      setStatusMessage('Profile saved successfully.')
      setRefreshKey((value) => value + 1)
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Profile save failed.')
    }
  }

  async function handleConvert() {
    if (!data) return
    setConverting(true)
    try {
      await profilesApi.convert(profileId, { expectedUpdatedAt: data.profile.updatedAt })
      setConfirmingConvert(false)
      setStatusMessage('Prospect converted to client.')
      setRefreshKey((value) => value + 1)
    } catch (convertError) {
      setConfirmingConvert(false)
      setStatusMessage(convertError instanceof Error ? convertError.message : 'Conversion failed.')
    } finally {
      setConverting(false)
    }
  }

  async function handleAddNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!noteBody.trim()) return
    try {
      await api.post(routes.profileNotes(profileId), { body: noteBody })
      setNoteBody('')
      setStatusMessage('Note added.')
      setRefreshKey((value) => value + 1)
    } catch (noteError) {
      setStatusMessage(noteError instanceof Error ? noteError.message : 'Note creation failed.')
    }
  }

  if (loading) return <LoadingState label="Loading profile" />
  if (error || !data) return <ErrorState title="Profile detail failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageHero
        eyebrow="Profile detail"
        title={profileName(data.profile)}
        subtitle={`${data.profile.kind} profile with editing, notes, household linkage, sensitive data, form shortcuts, and export shortcuts in one shareable URL.`}
        actions={
          <>
            <ButtonLink to={`/forms?profileId=${data.profile.id}`}>Forms</ButtonLink>
            <ButtonLink to={`/exports?profileId=${data.profile.id}`}>Exports</ButtonLink>
          </>
        }
        meta={
          <>
            <StatusBadge status={data.profile.kind} />
            <StatusBadge status={data.profile.stage || 'No stage'} />
          </>
        }
      />
      <PageSection
        title={profileName(data.profile)}
        subtitle={`${data.profile.kind} / ${data.profile.stage || 'No stage'} / Updated ${formatDateTime(data.profile.updatedAt || data.profile.createdAt)}`}
      >
        <div className="split-grid">
          <ActionPanel
            title="Editable details"
            subtitle="Core contact fields update through the canonical profile endpoint."
          >
            <form className="form-grid two-up" onSubmit={handleSave}>
              <Field label="First name">
                <input
                  name="firstName"
                  defaultValue={data.profile.firstName}
                  disabled={!hasGuard(user, 'canWriteProfiles')}
                />
              </Field>
              <Field label="Last name">
                <input
                  name="lastName"
                  defaultValue={data.profile.lastName}
                  disabled={!hasGuard(user, 'canWriteProfiles')}
                />
              </Field>
              <Field label="Email">
                <input
                  name="email"
                  defaultValue={String(data.profile.email || '')}
                  disabled={!hasGuard(user, 'canWriteProfiles')}
                />
              </Field>
              <Field label="Phone">
                <input
                  name="phone"
                  defaultValue={String(data.profile.phone || '')}
                  disabled={!hasGuard(user, 'canWriteProfiles')}
                />
              </Field>
              <button type="submit" disabled={!hasGuard(user, 'canWriteProfiles')}>
                Save changes
              </button>
            </form>
            <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
              {statusMessage || 'Inline editing lives here instead of on the list page.'}
            </p>
            {data.profile.kind === 'prospect' && hasGuard(user, 'canWriteProfiles') ? (
              <div className="compact-stack" data-testid="profile-convert">
                {confirmingConvert ? (
                  <>
                    <p className="muted compact">
                      Converting promotes this prospect to an active client, removes it from the pipeline board, and
                      clears its stage. This cannot be undone from here.
                    </p>
                    <div className="actions-row">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={converting}
                        onClick={() => void handleConvert()}
                      >
                        Confirm convert to client
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={converting}
                        onClick={() => setConfirmingConvert(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setStatusMessage('')
                      setConfirmingConvert(true)
                    }}
                  >
                    Convert to client
                  </button>
                )}
              </div>
            ) : null}
          </ActionPanel>

          <Card className="section-card">
            <h3>Tags</h3>
            <p className="muted">Lightweight labels for segmenting prospects and clients.</p>
            <ProfileTagsEditor
              profileId={data.profile.id}
              tags={data.profile.tags}
              canEdit={hasGuard(user, 'canWriteProfiles')}
              onChange={() => setRefreshKey((value) => value + 1)}
            />
          </Card>

          <Card className="section-card">
            <h3>Household + shortcuts</h3>
            <KeyValueList
              rows={[
                {
                  label: 'Household',
                  value: data.household ? (
                    <Link className="text-link" to={`/households/${data.household.id}`}>
                      {data.household.name}
                    </Link>
                  ) : (
                    'Not linked yet'
                  )
                },
                { label: 'Household members', value: String(data.householdMembers.length) },
                {
                  label: 'Forms',
                  value: (
                    <Link className="text-link" to={`/forms?profileId=${data.profile.id}`}>
                      {data.submissions.length} linked submissions
                    </Link>
                  )
                },
                {
                  label: 'Exports',
                  value: (
                    <Link className="text-link" to={`/exports?profileId=${data.profile.id}`}>
                      Open exports for this profile
                    </Link>
                  )
                }
              ]}
            />
          </Card>
        </div>
      </PageSection>

      <div className="split-grid">
        <PageSection title="Notes" subtitle="Advisor notes stay on the dedicated detail route.">
          <form className="form-grid" onSubmit={handleAddNote}>
            <Field label="Add note">
              <textarea
                rows={4}
                value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
                disabled={!hasGuard(user, 'canWriteProfiles')}
              />
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canWriteProfiles')}>
              Save note
            </button>
          </form>
          <Timeline
            items={data.notes.map((note) => ({
              id: note.id,
              title: formatDateTime(note.createdAt),
              body: note.body
            }))}
            empty={<EmptyState title="No notes yet." detail="Add the first advisor note above." />}
          />
        </PageSection>

        <PageSection title="Stage history" subtitle="Timeline for pipeline movement and progression.">
          {data.stageHistory.length ? (
            <DataTable caption="Stage movement history">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Changed by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.stageHistory.map((entry, index) => (
                  <tr key={`${entry.changedAt || index}-${index}`}>
                    <td>{entry.fromStage || '-'}</td>
                    <td>{entry.toStage || '-'}</td>
                    <td>{entry.changedByUserId || 'system'}</td>
                    <td>{formatDateTime(entry.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <EmptyState title="No stage movement yet." detail="Pipeline stage changes will appear here." />
          )}
        </PageSection>
      </div>

      <PageSection
        title="Sensitive data"
        subtitle="Preserves the current backend guard without weakening access boundaries."
      >
        {hasGuard(user, 'canReadSensitiveProfileData') ? (
          sensitive.loading ? (
            <LoadingState label="Loading sensitive data" />
          ) : sensitive.error ? (
            <InlineNotice tone="warning">{sensitive.error.message}</InlineNotice>
          ) : (
            <pre className="json-block">{JSON.stringify(sensitive.data, null, 2)}</pre>
          )
        ) : (
          <InlineNotice tone="warning">Your role cannot view masked sensitive profile data.</InlineNotice>
        )}
      </PageSection>
    </div>
  )
}
