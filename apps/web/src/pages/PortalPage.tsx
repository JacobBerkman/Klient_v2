import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, api, routes } from '../lib/client'
import {
  appendRepeaterRow,
  fieldInputType,
  removeRepeaterRow,
  repeaterRows,
  sectionStorageKey,
  updateRepeaterRow
} from '../lib/formSchema'
import { isFieldVisible, isRepeatableSection } from '../lib/formConditions'
import { formatDateTime, profileName } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import { autosaveStatusLabel, useAutosave } from '../lib/useAutosave'
import type {
  ClientWorkspacePayload,
  FormField,
  FormSection,
  FormTemplate,
  PortalDraftSectionSaveResult,
  PortalDraftSectionState,
  PortalPayload
} from '../lib/types'
import { useAuth } from '../app/auth'
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
  title: 'Portal',
  subtitle: 'Dedicated client workspace route for signed-in clients and token-based portal sessions.',
  breadcrumb: 'Portal'
}

type PortalScreenData =
  | {
      mode: 'client'
      templates: FormTemplate[]
      submissions: ClientWorkspacePayload['submissions']
      uploads: ClientWorkspacePayload['uploads']
      profileName: string
      progress: ClientWorkspacePayload['templateProgress']
    }
  | {
      mode: 'token'
      templates: FormTemplate[]
      submissions: NonNullable<PortalPayload['submissions']>
      uploads: NonNullable<PortalPayload['uploads']>
      profileName: string
      progress: Array<Record<string, unknown>>
    }
  | {
      mode: 'empty'
    }

function renderField(
  field: FormField,
  value: string,
  onChange: (value: string) => void,
  disabled: boolean,
  suffix = ''
) {
  if (field.type === 'textarea') {
    return (
      <label key={`${field.key}${suffix}`}>
        <span>{field.label || field.key}</span>
        <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
      </label>
    )
  }

  if (field.type === 'select') {
    return (
      <label key={`${field.key}${suffix}`}>
        <span>{field.label || field.key}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
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
    <label key={`${field.key}${suffix}`}>
      <span>{field.label || field.key}</span>
      <input
        type={fieldInputType(field)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  )
}

async function fetchPortalTokenData(token: string) {
  const response = await fetch(routes.portal(token), { credentials: 'same-origin' })
  const body = (await response.json()) as PortalPayload | { message?: string }
  if (!response.ok) {
    throw new Error((body as { message?: string }).message || 'Unable to load portal token data.')
  }
  return body as PortalPayload
}

async function postPortalSubmission(token: string, payload: Record<string, unknown>) {
  const response = await fetch(routes.portalSubmissions(token), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(
      String(
        body.message || (body.error as Record<string, unknown> | undefined)?.message || 'Portal submission failed.'
      )
    )
  }
  return body
}

// Load the revision-tracked per-section states for an existing portal draft so
// the client can adopt each section's server version and reconcile local edits.
async function fetchPortalDraftSections(token: string, draftId: string): Promise<PortalDraftSectionState[]> {
  const response = await fetch(routes.portalDraftSections(token, draftId), { credentials: 'same-origin' })
  const body = (await response.json()) as PortalDraftSectionState[] | { message?: string }
  if (!response.ok) {
    throw new Error((body as { message?: string }).message || 'Unable to load draft sections.')
  }
  return Array.isArray(body) ? body : []
}

// Save one section via the optimistic-concurrency PUT. A 409 is surfaced as an
// ApiError whose `body` carries the latest server state so the caller can
// reconcile without clobbering the concurrent edit.
async function putPortalDraftSection(
  token: string,
  draftId: string,
  sectionId: string,
  payload: { expectedVersion: number; data: Record<string, unknown> }
): Promise<PortalDraftSectionSaveResult> {
  const response = await fetch(routes.portalDraftSection(token, draftId, sectionId), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = (await response.json()) as PortalDraftSectionSaveResult & { message?: string }
  if (!response.ok) {
    throw new ApiError(String(body?.reason || body?.message || 'Section save conflict.'), {
      status: response.status,
      body
    })
  }
  return body
}

// The stable section identifier the server keys draft_step_states on. It matches
// the backend's normalizeSectionIdentifier so client keys line up with the ids
// returned by the GET sections route (lower/snake, no leading/trailing '_').
function portalSectionId(section: FormSection, index: number) {
  return (
    sectionStorageKey(section, index)
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || `section_${index + 1}`
  )
}

// A section's slice of the flat draft object: repeatable sections carry their
// row array under the storage key, scalar sections carry each field value.
function extractSectionSlice(
  data: Record<string, unknown>,
  section: FormSection,
  index: number
): Record<string, unknown> {
  if (isRepeatableSection(section)) {
    return { [sectionStorageKey(section, index)]: repeaterRows(data, section, index) }
  }
  const slice: Record<string, unknown> = {}
  for (const field of section.fields || []) {
    slice[field.key] = data[field.key] ?? ''
  }
  return slice
}

interface PortalDraftSectionProps {
  section: FormSection
  sectionIndex: number
  token: string
  draftId: string | null
  ensureDraft: () => Promise<string>
  versionsRef: MutableRefObject<Record<string, number>>
  flushRegistryRef: MutableRefObject<Record<string, () => void>>
  draftData: Record<string, unknown>
  setDraftData: Dispatch<SetStateAction<Record<string, unknown>>>
  enabled: boolean
}

// Renders one form section and, in token mode, autosaves that section
// independently via the per-section PUT. It reuses the shared debounced
// useAutosave (1.5s debounce + blur flush, 409-aware); on conflict it reloads
// the server's latest section state instead of overwriting it.
function PortalDraftSection({
  section,
  sectionIndex,
  token,
  draftId,
  ensureDraft,
  versionsRef,
  flushRegistryRef,
  draftData,
  setDraftData,
  enabled
}: PortalDraftSectionProps) {
  const sectionId = useMemo(() => portalSectionId(section, sectionIndex), [section, sectionIndex])
  const slice = useMemo(() => extractSectionSlice(draftData, section, sectionIndex), [draftData, section, sectionIndex])
  const conflictStateRef = useRef<PortalDraftSectionState | null>(null)
  const [reloaded, setReloaded] = useState(false)

  const autosave = useAutosave<Record<string, unknown>>({
    value: slice,
    enabled,
    save: async (value) => {
      const id = draftId || (await ensureDraft())
      const expectedVersion = versionsRef.current[sectionId] ?? 0
      try {
        const result = await putPortalDraftSection(token, id, sectionId, { expectedVersion, data: value })
        if (result.state) versionsRef.current[sectionId] = Number(result.state.version || 0)
        setReloaded(false)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const body = error.body as PortalDraftSectionSaveResult | undefined
          if (body?.state) conflictStateRef.current = body.state
        }
        throw error
      }
    }
  })

  // On a 409 the save threw with the server's latest state attached. Adopt that
  // state (advance the revision + merge the server slice into the draft) and
  // re-baseline autosave, so we surface the conflict without silently clobbering
  // the concurrent edit and the next keystroke saves cleanly.
  useEffect(() => {
    if (autosave.status !== 'conflict') return
    const serverState = conflictStateRef.current
    if (!serverState) return
    conflictStateRef.current = null
    versionsRef.current[sectionId] = Number(serverState.version || 0)
    const serverSlice = serverState.data && typeof serverState.data === 'object' ? serverState.data : {}
    setDraftData((current) => ({ ...current, ...serverSlice }))
    autosave.reset(serverSlice)
    setReloaded(true)
  }, [autosave.status])

  // Register this section's flush so the shared container onBlur can flush every
  // section's pending save when focus leaves the form (Card does not forward
  // onBlur, so the parent drives blur flushing).
  useEffect(() => {
    if (!enabled) return
    const registry = flushRegistryRef.current
    registry[sectionId] = () => autosave.flush()
    return () => {
      delete registry[sectionId]
    }
  }, [enabled, sectionId, autosave.flush, flushRegistryRef])

  const statusLabel = reloaded
    ? 'Conflict — reloaded latest'
    : autosaveStatusLabel(autosave.status) || (enabled ? 'Autosave on' : '')
  const statusClass =
    reloaded || autosave.status === 'error' || autosave.status === 'conflict'
      ? 'autosave-status is-error'
      : 'autosave-status'

  const sectionStatus = enabled ? (
    <p className={statusClass} role="status" aria-live="polite">
      {statusLabel}
    </p>
  ) : null

  if (isRepeatableSection(section)) {
    const rows = repeaterRows(draftData, section, sectionIndex)
    return (
      <Card className="section-card inset-card">
        <div className="row-between">
          <div>
            <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
            <p className="muted">Add repeatable entries as needed.</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setDraftData((current) => appendRepeaterRow(current, section, sectionIndex))}
          >
            Add row
          </button>
        </div>
        {sectionStatus}
        {rows.length ? (
          rows.map((row, rowIndex) => {
            const rowObject = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
            return (
              <Card key={`${sectionStorageKey(section, sectionIndex)}-${rowIndex}`} className="section-card inset-card">
                <div className="row-between">
                  <strong>Row {rowIndex + 1}</strong>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setDraftData((current) => removeRepeaterRow(current, section, sectionIndex, rowIndex))
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className="form-grid two-up">
                  {(section.fields || [])
                    .filter((field) => isFieldVisible(field, rowObject))
                    .map((field) =>
                      renderField(
                        field,
                        String(rowObject[field.key] || ''),
                        (nextValue) =>
                          setDraftData((current) =>
                            updateRepeaterRow(current, section, sectionIndex, rowIndex, {
                              ...rowObject,
                              [field.key]: nextValue
                            })
                          ),
                        false,
                        `-${rowIndex}`
                      )
                    )}
                </div>
              </Card>
            )
          })
        ) : (
          <InlineNotice tone="info">No rows yet. Add one to start.</InlineNotice>
        )}
      </Card>
    )
  }

  return (
    <Card className="section-card inset-card">
      <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
      {sectionStatus}
      <div className="form-grid two-up">
        {(section.fields || [])
          .filter((field) => isFieldVisible(field, draftData))
          .map((field) =>
            renderField(
              field,
              String(draftData[field.key] || ''),
              (nextValue) =>
                setDraftData((current) => ({
                  ...current,
                  [field.key]: nextValue
                })),
              false
            )
          )}
      </div>
    </Card>
  )
}

export function Component() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [draftData, setDraftData] = useState<Record<string, unknown>>({})
  const [statusMessage, setStatusMessage] = useState('')
  // Per-section revision tracking for the portal token per-section PUT. draftId
  // is the existing draft submission adopted from the portal payload (or created
  // lazily on first edit); versionsRef holds each section's server version.
  const [draftId, setDraftId] = useState<string | null>(null)
  // Bumped on every wholesale draft reset (template switch, adopt, post-submit)
  // so section editors remount and re-baseline autosave against the fresh data.
  const [adoptGeneration, setAdoptGeneration] = useState(0)
  const versionsRef = useRef<Record<string, number>>({})
  const flushRegistryRef = useRef<Record<string, () => void>>({})
  const draftIdRef = useRef<string | null>(null)
  const draftDataRef = useRef<Record<string, unknown>>({})
  const creatingDraftRef = useRef<Promise<string> | null>(null)

  draftIdRef.current = draftId
  draftDataRef.current = draftData

  const { data, error, loading } = useAsync<PortalScreenData>(async () => {
    if (token) {
      const payload = await fetchPortalTokenData(token)
      return {
        mode: 'token',
        templates: payload.availableTemplates || [],
        submissions: payload.submissions || [],
        uploads: payload.uploads || [],
        profileName: profileName(payload.profile),
        progress: (payload.availableTemplates || []).map((template) => ({
          templateId: template.id,
          templateName: template.name,
          status: (payload.submissions || []).find((entry) => entry.templateId === template.id)?.status || 'not_started'
        }))
      }
    }

    if (user?.role === 'client') {
      const payload = await api.get<ClientWorkspacePayload>(routes.clientWorkspace())
      return {
        mode: 'client',
        templates: payload.templates || [],
        submissions: payload.submissions || [],
        uploads: payload.uploads || [],
        profileName: profileName(payload.profile),
        progress: payload.templateProgress || []
      }
    }

    return { mode: 'empty' }
  }, [token, user?.id, user?.role, refreshKey])

  const selectedTemplate = useMemo(() => {
    if (!data || data.mode === 'empty') return null
    return data.templates.find((template) => template.id === selectedTemplateId) || null
  }, [data, selectedTemplateId])
  const selectedTemplateRef = useRef<FormTemplate | null>(null)
  selectedTemplateRef.current = selectedTemplate

  const tokenMode = data?.mode === 'token'

  // Whole-draft autosave for the signed-in client workspace (no per-section
  // route exists there). Token sessions autosave each section independently
  // instead, so this is disabled in token mode to avoid a double write.
  const portalAutosave = useAutosave<Record<string, unknown>>({
    value: draftData,
    enabled: Boolean(selectedTemplate) && data?.mode === 'client',
    save: async (dataToSave) => {
      if (!selectedTemplate) return
      await api.post(routes.clientFormSubmissions(), {
        templateId: selectedTemplate.id,
        status: 'draft',
        data: dataToSave
      })
    }
  })

  // Create a draft submission on demand so the per-section PUT (which requires an
  // existing draft id) has something to write against. Deduped via a ref so
  // concurrent section saves share one creation.
  const ensureDraft = useCallback(async () => {
    if (draftIdRef.current) return draftIdRef.current
    if (creatingDraftRef.current) return creatingDraftRef.current
    const template = selectedTemplateRef.current
    if (!token || !template) throw new Error('Select a template first.')
    const promise = (async () => {
      const created = await postPortalSubmission(token, {
        templateId: template.id,
        status: 'draft',
        data: draftDataRef.current
      })
      const id = String((created as { id?: string }).id || '')
      if (!id) throw new Error('Draft creation failed.')
      draftIdRef.current = id
      setDraftId(id)
      return id
    })()
    creatingDraftRef.current = promise
    try {
      return await promise
    } finally {
      creatingDraftRef.current = null
    }
  }, [token])

  useEffect(() => {
    if (!data || data.mode === 'empty') return
    const fallback = data.templates[0]?.id || ''
    setSelectedTemplateId((current) => current || fallback)
  }, [data])

  // Adopt the existing draft (and its per-section revisions) for the selected
  // template, or reset to a blank draft. Bumping adoptGeneration remounts the
  // section editors so their autosave baseline matches the freshly loaded data.
  useEffect(() => {
    if (!data || data.mode === 'empty') return
    const template = data.templates.find((entry) => entry.id === selectedTemplateId) || null
    let cancelled = false

    async function adopt() {
      versionsRef.current = {}
      if (!template || !data || data.mode !== 'token') {
        // Signed-in (non-token) mode has no server-side draft to adopt, but the
        // form still opens pre-filled from the client's records.
        const seed = template ? { ...(template.prefill || {}) } : {}
        draftIdRef.current = null
        setDraftId(null)
        setDraftData(seed)
        portalAutosave.reset(seed)
        setAdoptGeneration((value) => value + 1)
        return
      }
      const existing = data.submissions.find((entry) => entry.templateId === template.id && entry.status === 'draft')
      if (!existing) {
        // A fresh form opens PRE-FILLED from the client's firm records, so they
        // confirm or correct known details instead of retyping them. Whatever
        // they leave in place is submitted as their own answer — which is what
        // the exported PDF reads. Only a brand-new draft is seeded: re-seeding
        // an existing one would resurrect values the client deliberately cleared.
        draftIdRef.current = null
        setDraftId(null)
        setDraftData({ ...(template.prefill || {}) })
        setAdoptGeneration((value) => value + 1)
        return
      }
      const base = existing.data && typeof existing.data === 'object' ? (existing.data as Record<string, unknown>) : {}
      let merged: Record<string, unknown> = { ...base }
      const versions: Record<string, number> = {}
      try {
        const states = await fetchPortalDraftSections(token, existing.id)
        for (const state of states) {
          versions[state.sectionId] = Number(state.version || 0)
          if (state.data && typeof state.data === 'object') merged = { ...merged, ...state.data }
        }
      } catch {
        // Section states are best-effort; fall back to the submission snapshot.
      }
      if (cancelled) return
      versionsRef.current = versions
      draftIdRef.current = existing.id
      setDraftId(existing.id)
      setDraftData(merged)
      setAdoptGeneration((value) => value + 1)
    }

    void adopt()
    return () => {
      cancelled = true
    }
  }, [data, selectedTemplateId])

  async function handleSubmit(status: 'draft' | 'submitted') {
    if (!selectedTemplate) {
      setStatusMessage('Select a template first.')
      return
    }
    setStatusMessage(status === 'draft' ? 'Saving draft...' : 'Submitting form...')
    try {
      if (token) {
        await postPortalSubmission(token, {
          templateId: selectedTemplate.id,
          status,
          data: draftData
        })
      } else {
        await api.post(routes.clientFormSubmissions(), {
          templateId: selectedTemplate.id,
          status,
          data: draftData
        })
      }
      draftIdRef.current = null
      setDraftId(null)
      versionsRef.current = {}
      setDraftData({})
      portalAutosave.reset({})
      setStatusMessage(status === 'draft' ? 'Draft saved.' : 'Form submitted.')
      setRefreshKey((value) => value + 1)
    } catch (submitError) {
      setStatusMessage(submitError instanceof Error ? submitError.message : 'Unable to save portal form.')
    }
  }

  if (loading) return <LoadingState label="Loading portal" />
  if (error || !data) return <ErrorState title="Portal failed to load." detail={error?.message} />
  if (data.mode === 'empty') {
    return (
      <div className="portal-shell">
        <PageHero
          eyebrow="Client workspace"
          title="Portal"
          subtitle="Use a secure token link or sign in as a client to access forms and uploads."
        />
        <PageSection
          title="Portal access"
          subtitle="This route is for signed-in clients or token-based portal sessions."
        >
          <InlineNotice tone="info">
            Open `/portal?token=...` for a shared portal link, or sign in as a client to use the workspace route.
          </InlineNotice>
        </PageSection>
      </div>
    )
  }

  return (
    <div className="portal-shell">
      <div className="stack">
        <PageHero
          eyebrow={data.mode === 'client' ? 'Client workspace' : 'Secure portal'}
          title={data.profileName}
          subtitle={
            data.mode === 'client'
              ? 'Your forms, drafts, and uploads are organized in one workspace.'
              : 'Your secure shared link opens the same polished routed workspace.'
          }
          meta={
            <>
              <StatusBadge status={`${data.templates.length} forms`} />
              <StatusBadge status={`${data.uploads.length} uploads`} />
            </>
          }
        />
        <div role="status" aria-live="polite" aria-atomic="true">
          {statusMessage ? <InlineNotice tone="info">{statusMessage}</InlineNotice> : null}
        </div>

        <div className="split-grid">
          <PageSection title="Progress" subtitle="See what is complete, in draft, or still waiting.">
            {data.progress.length ? (
              <div className="compact-stack">
                {data.progress.map((entry, index) => (
                  <div key={`progress-${index}`} className="row-between">
                    <span>{String(entry.templateName || entry.templateId || `Template ${index + 1}`)}</span>
                    <StatusBadge status={String(entry.status || 'not_started')} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No portal progress yet." detail="No shared templates are currently visible." />
            )}
          </PageSection>

          <PageSection title="History" subtitle="Recent submissions and document activity for the current workspace.">
            {data.submissions.length ? (
              <div className="compact-stack">
                {data.submissions.map((submission) => (
                  <Card key={submission.id} className="section-card inset-card">
                    <div className="row-between">
                      <strong>{submission.templateId}</strong>
                      <StatusBadge status={submission.status} />
                    </div>
                    <p className="muted">Updated {formatDateTime(submission.updatedAt || submission.createdAt)}</p>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState title="No submission history." detail="Saved drafts and submitted forms will appear here." />
            )}
            {data.uploads.length ? (
              <pre className="json-block">{JSON.stringify(data.uploads, null, 2)}</pre>
            ) : (
              <InlineNotice tone="info">No uploads are visible yet.</InlineNotice>
            )}
          </PageSection>
        </div>

        <PageSection title="Complete a form" subtitle="Shared templates now render on the routed portal screen.">
          {data.templates.length ? (
            <div className="compact-stack">
              <div className="toolbar">
                <select
                  aria-label="Select a form template"
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                >
                  {data.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedTemplate ? (
                <div
                  className="compact-stack"
                  onBlur={() => {
                    portalAutosave.flush()
                    for (const flush of Object.values(flushRegistryRef.current)) flush()
                  }}
                >
                  <p
                    className={
                      portalAutosave.status === 'error' || portalAutosave.status === 'conflict'
                        ? 'autosave-status is-error'
                        : 'autosave-status'
                    }
                    role="status"
                    aria-live="polite"
                  >
                    {tokenMode
                      ? 'Each section autosaves on its own.'
                      : autosaveStatusLabel(portalAutosave.status) || 'Autosave on'}
                  </p>
                  {selectedTemplate.sections.map((section, sectionIndex) => (
                    <PortalDraftSection
                      key={`section-${sectionIndex}-${adoptGeneration}`}
                      section={section}
                      sectionIndex={sectionIndex}
                      token={token}
                      draftId={draftId}
                      ensureDraft={ensureDraft}
                      versionsRef={versionsRef}
                      flushRegistryRef={flushRegistryRef}
                      draftData={draftData}
                      setDraftData={setDraftData}
                      enabled={tokenMode}
                    />
                  ))}
                  <div className="actions-row">
                    <button type="button" onClick={() => void handleSubmit('submitted')}>
                      Submit form
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void handleSubmit('draft')}>
                      Save draft
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState
              title="No templates shared."
              detail="Once templates are shared to this workspace, they will appear here with a proper routed form experience."
            />
          )}
        </PageSection>
      </div>
    </div>
  )
}
