import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { autosaveStatusLabel, useAutosave } from '../lib/useAutosave'
import {
  appendRepeaterRow,
  fieldInputType,
  removeRepeaterRow,
  repeaterRows,
  sectionStorageKey,
  updateRepeaterRow
} from '../lib/formSchema'
import { isFieldVisible, isRepeatableSection } from '../lib/formConditions'
import { collaboratorSummary, formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type {
  DraftCollaboratorsPayload,
  DraftLockPayload,
  FormField,
  FormSubmission,
  FormTemplate,
  Profile,
  UserLookup
} from '../lib/types'
import { useAuth } from '../app/auth'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/toast'
import {
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  PageHero,
  PageSection,
  StatusBadge
} from '../components/ui'

export const handle = {
  title: ({ submissionId }: Record<string, string | undefined>) => `Submission ${submissionId || ''}`.trim(),
  subtitle: 'Dedicated editing route with lock, collaborator, and repeatable-item controls.',
  breadcrumb: 'Submission detail'
}

interface SubmissionDetailData {
  submissions: FormSubmission[]
  templates: FormTemplate[]
  profiles: Profile[]
}

function inputControl(
  field: FormField,
  value: unknown,
  onChange: (value: unknown) => void,
  disabled: boolean,
  labelSuffix = ''
) {
  if (field.type === 'checkbox' || field.type === 'boolean') {
    return (
      <label key={`${field.key}${labelSuffix}`} className="checkbox-field">
        <input
          type="checkbox"
          checked={value === true || String(value || '').toLowerCase() === 'true'}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        <span>{field.label || field.key}</span>
      </label>
    )
  }

  if (field.type === 'textarea') {
    return (
      <label key={`${field.key}${labelSuffix}`}>
        <span>{field.label || field.key}</span>
        <textarea
          rows={4}
          value={String(value || '')}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      </label>
    )
  }

  if (field.type === 'select') {
    return (
      <label key={`${field.key}${labelSuffix}`}>
        <span>{field.label || field.key}</span>
        <select value={String(value || '')} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
          <option value="">Select</option>
          {(field.options || []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    )
  }

  return (
    <label key={`${field.key}${labelSuffix}`}>
      <span>{field.label || field.key}</span>
      <input
        type={fieldInputType(field)}
        value={String(value || '')}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  )
}

export function Component() {
  const { submissionId = '' } = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [editorData, setEditorData] = useState<Record<string, unknown>>({})
  const [statusMessage, setStatusMessage] = useState('')
  const [collaborators, setCollaborators] = useState<DraftCollaboratorsPayload | null>(null)
  const [lookupResults, setLookupResults] = useState<UserLookup[]>([])
  const [lookupQuery, setLookupQuery] = useState('')
  const [selectedCollaboratorId, setSelectedCollaboratorId] = useState('')
  const [confirmingReleaseLock, setConfirmingReleaseLock] = useState(false)
  const [releasingLock, setReleasingLock] = useState(false)
  const [confirmingRemoveUserId, setConfirmingRemoveUserId] = useState('')
  const [removingCollaborator, setRemovingCollaborator] = useState(false)
  // Live draft revision + lease, advanced by autosave without a full refetch so
  // the next autosave uses the server's incremented revision.
  const revisionRef = useRef(1)
  const leaseRef = useRef<string | undefined>(undefined)

  const { data, error, loading } = useAsync<SubmissionDetailData>(async () => {
    const [submissions, templates, profiles] = await Promise.all([
      api.get<FormSubmission[]>(routes.formSubmissions()),
      api.get<FormTemplate[]>(routes.formTemplates()),
      api.get<Profile[]>(routes.profiles({ kind: 'client' }))
    ])
    return { submissions, templates, profiles }
  }, [submissionId, refreshKey])

  const submission = data?.submissions.find((entry) => entry.id === submissionId) || null
  const template = data?.templates.find((entry) => entry.id === submission?.templateId) || null
  const profile = data?.profiles.find((entry) => entry.id === submission?.clientId) || null

  useEffect(() => {
    if (!submission) return
    setEditorData((submission.data as Record<string, unknown>) || {})
  }, [submission?.id, submission?.updatedAt, submission?.revisionId])

  useEffect(() => {
    if (!submission || submission.status !== 'draft' || !hasGuard(user, 'canManageDraftSharing')) {
      setCollaborators(null)
      return
    }
    void api
      .get<DraftCollaboratorsPayload>(routes.formDraftCollaborators(submission.id))
      .then((payload) => setCollaborators(payload))
      .catch(() => setCollaborators(null))
  }, [submission?.id, submission?.status, user])

  const canWriteForms = hasGuard(user, 'canWriteForms')
  const canManageDrafts = hasGuard(user, 'canManageDraftSharing')
  const lockIsMine = Boolean(submission?.lock && user && submission.lock.holderUserId === user.id)
  const canEditDraft = Boolean(submission?.status === 'draft' && canWriteForms && lockIsMine)
  const canEditSubmission = Boolean(submission?.status === 'submitted' && canWriteForms)

  // Debounced autosave for the draft editor. Uses the existing revision/lease-
  // aware PATCH endpoint and respects its 409 conflict contract: a conflict is
  // surfaced (status 'conflict') and the stale revision is NOT advanced, so the
  // client never silently clobbers a concurrent edit.
  const autosave = useAutosave<Record<string, unknown>>({
    value: editorData,
    enabled: canEditDraft,
    save: async (dataToSave) => {
      if (!submission) return
      const result = await api.patch<{ ok?: boolean; submission?: FormSubmission }>(routes.formDraft(submission.id), {
        data: dataToSave,
        leaseId: leaseRef.current,
        expectedRevisionId: revisionRef.current,
        status: 'draft'
      })
      if (result?.submission) {
        revisionRef.current = Number(result.submission.revisionId || revisionRef.current)
        if (result.submission.lock?.leaseId) leaseRef.current = result.submission.lock.leaseId
      }
    }
  })

  useEffect(() => {
    if (!submission) return
    revisionRef.current = Number(submission.revisionId || 1)
    leaseRef.current = submission.lock?.leaseId
    autosave.reset((submission.data as Record<string, unknown>) || {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission?.id, submission?.updatedAt, submission?.revisionId])

  async function refreshWithMessage(message: string) {
    setStatusMessage(message)
    setRefreshKey((value) => value + 1)
  }

  async function handleAcquireLock(force = false) {
    if (!submission) return
    try {
      await api.post<DraftLockPayload>(routes.formDraftLock(submission.id), {
        leaseMs: 30_000,
        force
      })
      toast.success(force ? 'Draft lock force-acquired.' : 'Draft lock acquired.')
      setRefreshKey((value) => value + 1)
    } catch (lockError) {
      toast.error(lockError instanceof Error ? lockError.message : 'Unable to acquire draft lock.')
    }
  }

  async function handleReleaseLock() {
    if (!submission?.lock) return
    setReleasingLock(true)
    try {
      await api.delete(routes.formDraftLock(submission.id), { leaseId: submission.lock.leaseId })
      toast.success('Draft lock released.')
      setRefreshKey((value) => value + 1)
    } catch (lockError) {
      toast.error(lockError instanceof Error ? lockError.message : 'Unable to release draft lock.')
    } finally {
      setConfirmingReleaseLock(false)
      setReleasingLock(false)
    }
  }

  async function handleSaveDraft(status: 'draft' | 'submitted') {
    if (!submission) return
    try {
      await api.patch(routes.formDraft(submission.id), {
        data: editorData,
        leaseId: leaseRef.current ?? submission.lock?.leaseId,
        expectedRevisionId: revisionRef.current || submission.revisionId || 1,
        status
      })
      await refreshWithMessage(status === 'submitted' ? 'Draft submitted.' : 'Draft saved.')
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Draft save failed.')
    }
  }

  async function handleSaveSubmission() {
    if (!submission) return
    try {
      await api.patch(routes.formSubmission(submission.id), {
        data: editorData,
        expectedUpdatedAt: submission.updatedAt
      })
      await refreshWithMessage('Submission updated.')
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Submission update failed.')
    }
  }

  async function handleSearchUsers(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!lookupQuery.trim()) {
      setLookupResults([])
      return
    }
    try {
      const payload = await api.get<{ users: UserLookup[] }>(
        routes.users({ mode: 'lookup', search: lookupQuery, includeSelf: false })
      )
      setLookupResults(payload.users || [])
    } catch (lookupError) {
      setLookupResults([])
      setStatusMessage(lookupError instanceof Error ? lookupError.message : 'User lookup failed.')
    }
  }

  async function handleAddCollaborator(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!submission || !selectedCollaboratorId) return
    try {
      const payload = await api.post<DraftCollaboratorsPayload>(routes.formDraftCollaborators(submission.id), {
        userId: selectedCollaboratorId,
        permission: 'write'
      })
      setCollaborators(payload)
      setSelectedCollaboratorId('')
      toast.success('Collaborator added.')
      setRefreshKey((value) => value + 1)
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : 'Unable to add collaborator.')
    }
  }

  async function handleRemoveCollaborator(collaboratorUserId: string) {
    if (!submission) return
    setRemovingCollaborator(true)
    try {
      const payload = await api.delete<DraftCollaboratorsPayload>(
        routes.formDraftCollaborator(submission.id, collaboratorUserId)
      )
      setCollaborators(payload)
      toast.success('Collaborator removed.')
      setRefreshKey((value) => value + 1)
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : 'Unable to remove collaborator.')
    } finally {
      setConfirmingRemoveUserId('')
      setRemovingCollaborator(false)
    }
  }

  async function handleSaveRepeaterRow(sectionIndex: number, rowIndex: number) {
    if (!submission || !template) return
    const section = template.sections[sectionIndex]
    if (!section) return
    const rows = repeaterRows(editorData, section, sectionIndex)
    const row = rows[rowIndex]
    try {
      await api.patch(
        routes.formSubmissionSectionItem(submission.id, sectionStorageKey(section, sectionIndex), String(rowIndex)),
        {
          ...(row && typeof row === 'object' ? row : {}),
          expectedUpdatedAt: submission.updatedAt
        }
      )
      await refreshWithMessage('Repeater row saved.')
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Unable to save repeater row.')
    }
  }

  async function handleDeleteRepeaterRow(sectionIndex: number, rowIndex: number) {
    if (!submission || !template) return
    const section = template.sections[sectionIndex]
    if (!section) return
    try {
      await api.delete(
        `${routes.formSubmissionSectionItem(
          submission.id,
          sectionStorageKey(section, sectionIndex),
          String(rowIndex)
        )}?expectedUpdatedAt=${encodeURIComponent(String(submission.updatedAt || ''))}`
      )
      await refreshWithMessage('Repeater row deleted.')
    } catch (deleteError) {
      setStatusMessage(deleteError instanceof Error ? deleteError.message : 'Unable to delete repeater row.')
    }
  }

  if (loading) return <LoadingState label="Loading submission" />
  if (error || !data) return <ErrorState title="Submission detail failed to load." detail={error?.message} />
  if (!submission)
    return (
      <ErrorState
        title="Submission not found."
        detail="The requested submission is not present in the canonical forms response."
      />
    )

  return (
    <div className="stack">
      <PageHero
        eyebrow="Submission editor"
        title={template?.name || submission.templateId}
        subtitle={`A focused editing surface for ${profileName(profile)} with locks, collaborators, repeatable items, and revision-aware saves.`}
        meta={
          <>
            <StatusBadge status={submission.status} />
            <StatusBadge status={submission.lock ? 'Locked draft' : 'Unlocked'} />
            {template?.generatedFromDocumentTemplateId ? <StatusBadge status="Generated PDF form" /> : null}
          </>
        }
      />
      <PageSection
        title={template?.name || submission.templateId}
        subtitle={`${submission.status} for ${profileName(profile)}. Route-based editing keeps this flow shareable and browser-safe.`}
      >
        <div className="detail-grid">
          <Card className="section-card">
            <h3>Record context</h3>
            <div className="compact-stack">
              <div>
                <strong>Client</strong>
                <div>
                  <Link className="text-link" to={`/profiles/${submission.clientId}`}>
                    {profileName(profile)}
                  </Link>
                </div>
              </div>
              <div>
                <strong>Template ID</strong>
                <div className="muted">{submission.templateId}</div>
                {template?.generatedFromDocumentTemplateId ? (
                  <div className="compact-stack">
                    <Link className="text-link" to={`/templates/${template.generatedFromDocumentTemplateId}`}>
                      Open source document template
                    </Link>
                    <div className="muted">
                      Generated from {template.generation?.source || 'pdf_acroform'} with{' '}
                      {template.generation?.fieldCount || template.sections.flatMap((section) => section.fields).length}{' '}
                      fields.
                    </div>
                  </div>
                ) : null}
              </div>
              <div>
                <strong>Updated</strong>
                <div className="muted">{formatDateTime(submission.updatedAt || submission.createdAt)}</div>
              </div>
              <div>
                <strong>Status</strong>
                <div>
                  <StatusBadge status={submission.status} />
                </div>
              </div>
            </div>
          </Card>

          <Card className="section-card">
            <h3>Editing state</h3>
            {submission.status === 'draft' ? (
              <div className="compact-stack">
                <p className="muted">
                  Collaborators: {collaboratorSummary(collaborators?.collaborators || submission.collaborators)}
                </p>
                {submission.lock ? (
                  <InlineNotice tone={lockIsMine ? 'success' : 'warning'}>
                    {lockIsMine
                      ? 'You currently hold the draft lock.'
                      : `Locked by ${submission.lock.holderUserId} until ${formatDateTime(submission.lock.expiresAt)}.`}
                  </InlineNotice>
                ) : (
                  <InlineNotice tone="info">No active draft lock.</InlineNotice>
                )}
                <div className="actions-row">
                  <button type="button" onClick={() => void handleAcquireLock(false)} disabled={!canWriteForms}>
                    Acquire lock
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleAcquireLock(true)}
                    disabled={!canWriteForms}
                  >
                    Force takeover
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setConfirmingReleaseLock(true)}
                    disabled={!lockIsMine}
                  >
                    Release lock
                  </button>
                  <ConfirmDialog
                    open={confirmingReleaseLock}
                    title="Release draft lock?"
                    description="Releasing the lock stops your autosave lease and lets another collaborator take over editing this draft."
                    confirmLabel="Confirm release"
                    busy={releasingLock}
                    onConfirm={() => void handleReleaseLock()}
                    onCancel={() => setConfirmingReleaseLock(false)}
                  />
                </div>
              </div>
            ) : (
              <InlineNotice tone="info">
                Submitted records can be edited directly without draft lease management.
              </InlineNotice>
            )}
          </Card>
        </div>
      </PageSection>

      {statusMessage ? <InlineNotice tone="info">{statusMessage}</InlineNotice> : null}

      <div className="split-grid">
        <PageSection
          title="Form editor"
          subtitle="Scalar fields edit inline here, while repeaters keep explicit row controls."
        >
          {canEditDraft ? (
            <p
              className={
                autosave.status === 'error' || autosave.status === 'conflict'
                  ? 'autosave-status is-error'
                  : 'autosave-status'
              }
              role="status"
              aria-live="polite"
            >
              {autosaveStatusLabel(autosave.status) || 'Autosave on'}
            </p>
          ) : null}
          {template && template.sections.length ? (
            <div
              className="compact-stack"
              onBlur={() => {
                if (canEditDraft) autosave.flush()
              }}
            >
              {template.sections.map((section, sectionIndex) => {
                if (isRepeatableSection(section)) {
                  const rows = repeaterRows(editorData, section, sectionIndex)
                  return (
                    <Card key={sectionStorageKey(section, sectionIndex)} className="section-card">
                      <div className="row-between">
                        <div>
                          <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
                          <p className="muted">Repeatable item editing stays in the dedicated submission route.</p>
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setEditorData((current) => appendRepeaterRow(current, section, sectionIndex))}
                          disabled={!(canEditDraft || canEditSubmission)}
                        >
                          Add row
                        </button>
                      </div>
                      {rows.length ? (
                        <div className="compact-stack">
                          {rows.map((row, rowIndex) => {
                            const rowObject = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
                            return (
                              <Card
                                key={`${sectionStorageKey(section, sectionIndex)}-${rowIndex}`}
                                className="section-card inset-card"
                              >
                                <div className="row-between">
                                  <strong>Row {rowIndex + 1}</strong>
                                  <div className="actions-row">
                                    {submission.status === 'submitted' ? (
                                      <>
                                        <button
                                          type="button"
                                          className="secondary-button"
                                          onClick={() => void handleSaveRepeaterRow(sectionIndex, rowIndex)}
                                          disabled={!canEditSubmission}
                                        >
                                          Save row
                                        </button>
                                        <button
                                          type="button"
                                          className="ghost-button"
                                          onClick={() => void handleDeleteRepeaterRow(sectionIndex, rowIndex)}
                                          disabled={!canEditSubmission}
                                        >
                                          Delete row
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        className="ghost-button"
                                        onClick={() =>
                                          setEditorData((current) =>
                                            removeRepeaterRow(current, section, sectionIndex, rowIndex)
                                          )
                                        }
                                        disabled={!canEditDraft}
                                      >
                                        Remove row
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="form-grid two-up">
                                  {(section.fields || [])
                                    .filter((field) => isFieldVisible(field, rowObject))
                                    .map((field) =>
                                      inputControl(
                                        field,
                                        rowObject[field.key],
                                        (nextValue) =>
                                          setEditorData((current) =>
                                            updateRepeaterRow(current, section, sectionIndex, rowIndex, {
                                              ...rowObject,
                                              [field.key]: nextValue
                                            })
                                          ),
                                        submission.status === 'draft' ? !canEditDraft : !canEditSubmission,
                                        `-${rowIndex}`
                                      )
                                    )}
                                </div>
                              </Card>
                            )
                          })}
                        </div>
                      ) : (
                        <EmptyState title="No rows yet." detail="Add a row to begin editing repeatable content." />
                      )}
                    </Card>
                  )
                }

                return (
                  <Card key={sectionStorageKey(section, sectionIndex)} className="section-card">
                    <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
                    <div className="form-grid two-up">
                      {(section.fields || [])
                        .filter((field) => isFieldVisible(field, editorData))
                        .map((field) =>
                          inputControl(
                            field,
                            editorData[field.key],
                            (nextValue) =>
                              setEditorData((current) => ({
                                ...current,
                                [field.key]: nextValue
                              })),
                            submission.status === 'draft' ? !canEditDraft : !canEditSubmission
                          )
                        )}
                    </div>
                  </Card>
                )
              })}
            </div>
          ) : (
            <pre className="json-block">{JSON.stringify(editorData, null, 2)}</pre>
          )}
          <div className="actions-row">
            {submission.status === 'draft' ? (
              <>
                <button type="button" onClick={() => void handleSaveDraft('draft')} disabled={!canEditDraft}>
                  Save draft
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleSaveDraft('submitted')}
                  disabled={!canEditDraft}
                >
                  Submit draft
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void handleSaveSubmission()} disabled={!canEditSubmission}>
                Save submission
              </button>
            )}
          </div>
        </PageSection>

        <PageSection
          title="Collaborators"
          subtitle="Lock and membership management now live with the draft, not in the shell."
        >
          {submission.status !== 'draft' ? (
            <EmptyState
              title="No collaborator state."
              detail="Submitted records no longer participate in draft collaboration."
            />
          ) : (
            <div className="compact-stack">
              <div className="pill-list">
                {(collaborators?.collaborators || submission.collaborators || []).map((entry) => (
                  <span key={entry.userId} className="pill">
                    {entry.userId} ({entry.permission})
                  </span>
                ))}
              </div>

              {canManageDrafts ? (
                <>
                  <form className="form-grid" onSubmit={handleSearchUsers}>
                    <label>
                      <span>Search users</span>
                      <input
                        value={lookupQuery}
                        onChange={(event) => setLookupQuery(event.target.value)}
                        placeholder="Admin lookup by name or email"
                      />
                    </label>
                    <button type="submit">Search directory</button>
                  </form>

                  {lookupResults.length ? (
                    <form className="form-grid" onSubmit={handleAddCollaborator}>
                      <label>
                        <span>Add collaborator</span>
                        <select
                          value={selectedCollaboratorId}
                          onChange={(event) => setSelectedCollaboratorId(event.target.value)}
                          required
                        >
                          <option value="">Select a user</option>
                          {lookupResults.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.label || entry.email || entry.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="submit">Add collaborator</button>
                    </form>
                  ) : null}

                  {(collaborators?.collaborators || submission.collaborators || []).length ? (
                    <div className="compact-stack">
                      {(collaborators?.collaborators || submission.collaborators || []).map((entry) => (
                        <div key={entry.userId} className="row-between">
                          <span>
                            {entry.userId} ({entry.permission})
                          </span>
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setConfirmingRemoveUserId(entry.userId)}
                            disabled={entry.userId === submission.createdByUserId}
                          >
                            Remove
                          </button>
                          <ConfirmDialog
                            open={confirmingRemoveUserId === entry.userId}
                            title="Remove collaborator?"
                            description={`Removing ${entry.userId} revokes their ${entry.permission} access to this draft. They can be re-added from the directory search.`}
                            confirmLabel="Confirm remove"
                            tone="danger"
                            busy={removingCollaborator}
                            onConfirm={() => void handleRemoveCollaborator(entry.userId)}
                            onCancel={() => setConfirmingRemoveUserId('')}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <InlineNotice tone="warning">
                  Your role can view draft context, but collaborator management is restricted.
                </InlineNotice>
              )}
            </div>
          )}
        </PageSection>
      </div>
    </div>
  )
}
