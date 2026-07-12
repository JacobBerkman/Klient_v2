import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, profilesApi, routes } from '../lib/client'
import { formatBytes, formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type {
  ProfileDetailPayload,
  ProfileMeetingsPayload,
  ProfileUploadPresignPayload,
  ProfileUploadsPayload
} from '../lib/types'

const MEETING_TYPE_OPTIONS = [
  { value: 'intro', label: 'Intro' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'review', label: 'Review' },
  { value: 'other', label: 'Other' }
] as const
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

// Advisor attachments stream their raw bytes to the binary upload endpoint via a
// presign -> PUT -> complete handshake, so they are no longer bounded by the ~1MB
// JSON body limit. The 20MB ceiling mirrors the server's per-flow intent cap and
// fails fast client-side with a clear message before the request is made.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export function Component() {
  const { profileId = '' } = useParams()
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [noteBody, setNoteBody] = useState('')
  const [confirmingConvert, setConfirmingConvert] = useState(false)
  const [converting, setConverting] = useState(false)
  const [confirmingArchiveProfile, setConfirmingArchiveProfile] = useState(false)
  const [archivingProfile, setArchivingProfile] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState('')
  const [confirmingArchiveId, setConfirmingArchiveId] = useState('')
  const [archivingId, setArchivingId] = useState('')
  const [meetingType, setMeetingType] = useState<string>('intro')
  const [meetingScheduledAt, setMeetingScheduledAt] = useState('')
  const [meetingNotes, setMeetingNotes] = useState('')
  const [meetingMessage, setMeetingMessage] = useState('')
  const [confirmingDeleteMeetingId, setConfirmingDeleteMeetingId] = useState('')
  const [deletingMeetingId, setDeletingMeetingId] = useState('')

  const canWriteProfiles = hasGuard(user, 'canWriteProfiles')

  const { data, error, loading } = useAsync<ProfileDetailPayload>(
    () => api.get(routes.profileDetail(profileId)),
    [profileId, refreshKey]
  )
  const sensitive = useAsync<Record<string, unknown>>(
    () => api.get(routes.profileSensitive(profileId)),
    [profileId, refreshKey]
  )
  const uploads = useAsync<ProfileUploadsPayload>(
    () => api.get(routes.profileUploads(profileId)),
    [profileId, refreshKey]
  )
  const meetings = useAsync<ProfileMeetingsPayload>(
    () => api.get(routes.profileMeetings(profileId)),
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

  async function handleArchiveProfile() {
    if (!data) return
    setArchivingProfile(true)
    try {
      await profilesApi.archive(profileId, { expectedUpdatedAt: data.profile.updatedAt })
      setConfirmingArchiveProfile(false)
      setStatusMessage('Profile archived.')
      setRefreshKey((value) => value + 1)
    } catch (archiveError) {
      setConfirmingArchiveProfile(false)
      setStatusMessage(archiveError instanceof Error ? archiveError.message : 'Archive failed.')
    } finally {
      setArchivingProfile(false)
    }
  }

  async function handleRestoreProfile() {
    if (!data) return
    setArchivingProfile(true)
    try {
      await profilesApi.restore(profileId, { expectedUpdatedAt: data.profile.updatedAt })
      setStatusMessage('Profile restored.')
      setRefreshKey((value) => value + 1)
    } catch (restoreError) {
      setStatusMessage(restoreError instanceof Error ? restoreError.message : 'Restore failed.')
    } finally {
      setArchivingProfile(false)
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

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadMessage(`"${file.name}" is too large. Attachments must be under ${formatBytes(MAX_ATTACHMENT_BYTES)}.`)
      input.value = ''
      return
    }
    setUploading(true)
    setUploadMessage('')
    try {
      const contentType = file.type || 'application/octet-stream'
      const presign = await api.post<ProfileUploadPresignPayload>(routes.profileUploadsPresign(profileId), {
        fileName: file.name,
        contentType
      })
      await api.uploadRaw(presign.uploadId, presign.object.key, file)
      await api.post(routes.profileUploads(profileId), {
        uploadId: presign.uploadId,
        object: presign.object,
        name: file.name,
        fileName: file.name,
        contentType,
        sizeBytes: file.size
      })
      setUploadMessage(`Uploaded "${file.name}".`)
      setRefreshKey((value) => value + 1)
    } catch (uploadError) {
      setUploadMessage(uploadError instanceof Error ? uploadError.message : 'Attachment upload failed.')
    } finally {
      setUploading(false)
      input.value = ''
    }
  }

  async function handleArchive(uploadId: string) {
    setArchivingId(uploadId)
    try {
      await api.post(routes.profileUploadArchive(profileId, uploadId))
      setConfirmingArchiveId('')
      setUploadMessage('Attachment archived.')
      setRefreshKey((value) => value + 1)
    } catch (archiveError) {
      setConfirmingArchiveId('')
      setUploadMessage(archiveError instanceof Error ? archiveError.message : 'Archive failed.')
    } finally {
      setArchivingId('')
    }
  }

  async function handleAddMeeting(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await api.post(routes.profileMeetings(profileId), {
        meetingType,
        scheduledAt: meetingScheduledAt || null,
        notes: meetingNotes
      })
      setMeetingType('intro')
      setMeetingScheduledAt('')
      setMeetingNotes('')
      setMeetingMessage('Meeting logged.')
      setRefreshKey((value) => value + 1)
    } catch (meetingError) {
      setMeetingMessage(meetingError instanceof Error ? meetingError.message : 'Could not log meeting.')
    }
  }

  async function handleDeleteMeeting(meetingId: string) {
    setDeletingMeetingId(meetingId)
    try {
      await api.delete(routes.profileMeeting(profileId, meetingId))
      setConfirmingDeleteMeetingId('')
      setMeetingMessage('Meeting deleted.')
      setRefreshKey((value) => value + 1)
    } catch (meetingError) {
      setConfirmingDeleteMeetingId('')
      setMeetingMessage(meetingError instanceof Error ? meetingError.message : 'Meeting delete failed.')
    } finally {
      setDeletingMeetingId('')
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
            {data.profile.archivedAt ? <StatusBadge status="Archived" /> : null}
          </>
        }
      />
      {data.profile.archivedAt ? (
        <div data-testid="profile-archived-banner" className="compact-stack">
          <InlineNotice tone="warning">
            This profile is archived and hidden from lists, the pipeline board, dashboard counts, analytics, and client
            pickers. Its notes, uploads, and submissions are preserved.
          </InlineNotice>
          {hasGuard(user, 'canWriteProfiles') ? (
            <button
              type="button"
              className="secondary-button"
              disabled={archivingProfile}
              data-testid="profile-restore"
              onClick={() => void handleRestoreProfile()}
            >
              {archivingProfile ? 'Restoring...' : 'Restore profile'}
            </button>
          ) : null}
        </div>
      ) : null}
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
            {!data.profile.archivedAt && hasGuard(user, 'canWriteProfiles') ? (
              <div className="compact-stack" data-testid="profile-archive">
                {confirmingArchiveProfile ? (
                  <>
                    <p className="muted compact">
                      Archiving hides this {data.profile.kind} from lists, the pipeline board, dashboard counts,
                      analytics, and client pickers. Notes, uploads, and submissions are preserved, and you can restore
                      it later.
                    </p>
                    <div className="actions-row">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={archivingProfile}
                        onClick={() => void handleArchiveProfile()}
                      >
                        Confirm archive
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={archivingProfile}
                        onClick={() => setConfirmingArchiveProfile(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      setStatusMessage('')
                      setConfirmingArchiveProfile(true)
                    }}
                  >
                    Archive profile
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
        title="Attachments"
        subtitle="Documents stored against this profile. Uploads are firm-scoped and follow the same retention lifecycle as portal uploads."
      >
        {canWriteProfiles ? (
          <div className="attachment-upload">
            <label className={`attachment-upload-control${uploading ? ' is-disabled' : ''}`}>
              <span>{uploading ? 'Uploading…' : 'Upload attachment'}</span>
              <input
                type="file"
                className="attachment-file-input"
                disabled={uploading}
                onChange={(event) => void handleUpload(event)}
              />
            </label>
            <span className="muted compact">Max {formatBytes(MAX_ATTACHMENT_BYTES)} per file.</span>
          </div>
        ) : null}
        {uploadMessage ? (
          <p className="inline-notice inline-notice-info" data-testid="attachment-status">
            {uploadMessage}
          </p>
        ) : null}
        {uploads.loading ? (
          <LoadingState label="Loading attachments" />
        ) : uploads.error ? (
          <ErrorState title="Attachments failed to load." detail={uploads.error.message} />
        ) : uploads.data && uploads.data.uploads.length ? (
          <DataTable caption="Profile attachments">
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Uploaded by</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {uploads.data.uploads.map((upload) => (
                <tr key={upload.id} data-testid="attachment-row">
                  <td>{upload.name}</td>
                  <td>{formatBytes(upload.sizeBytes)}</td>
                  <td>{upload.uploadedByUserId || upload.uploadedBy || 'advisor'}</td>
                  <td>{formatDateTime(upload.updatedAt || upload.createdAt)}</td>
                  <td>
                    <div className="actions-row">
                      <a
                        className="text-link"
                        href={routes.profileUploadDownload(profileId, upload.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Download
                      </a>
                      {canWriteProfiles ? (
                        confirmingArchiveId === upload.id ? (
                          <>
                            <button
                              type="button"
                              className="ghost-button compact"
                              disabled={archivingId === upload.id}
                              onClick={() => void handleArchive(upload.id)}
                            >
                              Confirm archive
                            </button>
                            <button
                              type="button"
                              className="ghost-button compact"
                              disabled={archivingId === upload.id}
                              onClick={() => setConfirmingArchiveId('')}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ghost-button compact"
                            onClick={() => {
                              setUploadMessage('')
                              setConfirmingArchiveId(upload.id)
                            }}
                          >
                            Archive
                          </button>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <EmptyState
            title="No attachments yet."
            detail={canWriteProfiles ? 'Upload a document to attach it to this profile.' : 'No documents are attached to this profile.'}
          />
        )}
      </PageSection>

      <PageSection
        title="Meetings"
        subtitle="Lightweight log of meetings held with this profile (intro, proposal, review, or other)."
      >
        {canWriteProfiles ? (
          <form className="form-grid meeting-form" onSubmit={handleAddMeeting}>
            <Field label="Type">
              <select value={meetingType} onChange={(event) => setMeetingType(event.target.value)}>
                {MEETING_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When">
              <input
                type="datetime-local"
                value={meetingScheduledAt}
                onChange={(event) => setMeetingScheduledAt(event.target.value)}
              />
            </Field>
            <Field label="Note">
              <input
                type="text"
                value={meetingNotes}
                maxLength={2000}
                placeholder="Short note (optional)"
                onChange={(event) => setMeetingNotes(event.target.value)}
              />
            </Field>
            <button type="submit">Log meeting</button>
          </form>
        ) : null}
        {meetingMessage ? (
          <p className="inline-notice inline-notice-info" data-testid="meeting-status">
            {meetingMessage}
          </p>
        ) : null}
        {meetings.loading ? (
          <LoadingState label="Loading meetings" />
        ) : meetings.error ? (
          <ErrorState title="Meetings failed to load." detail={meetings.error.message} />
        ) : meetings.data && meetings.data.meetings.length ? (
          <DataTable caption="Profile meetings">
            <thead>
              <tr>
                <th>Type</th>
                <th>When</th>
                <th>Note</th>
                {canWriteProfiles ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {meetings.data.meetings.map((meeting) => (
                <tr key={meeting.id} data-testid="meeting-row">
                  <td>
                    <span className="role-pill">{meeting.meetingType || 'other'}</span>
                  </td>
                  <td>{meeting.scheduledAt ? formatDateTime(meeting.scheduledAt) : 'Unscheduled'}</td>
                  <td>{meeting.notes || '-'}</td>
                  {canWriteProfiles ? (
                    <td>
                      <div className="actions-row">
                        {confirmingDeleteMeetingId === meeting.id ? (
                          <>
                            <button
                              type="button"
                              className="ghost-button compact"
                              disabled={deletingMeetingId === meeting.id}
                              onClick={() => void handleDeleteMeeting(meeting.id)}
                            >
                              Confirm delete
                            </button>
                            <button
                              type="button"
                              className="ghost-button compact"
                              disabled={deletingMeetingId === meeting.id}
                              onClick={() => setConfirmingDeleteMeetingId('')}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="ghost-button compact"
                            onClick={() => {
                              setMeetingMessage('')
                              setConfirmingDeleteMeetingId(meeting.id)
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <EmptyState
            title="No meetings logged yet."
            detail={canWriteProfiles ? 'Log the first meeting with this profile above.' : 'No meetings are recorded for this profile.'}
          />
        )}
      </PageSection>

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
