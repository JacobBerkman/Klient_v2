import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, routes } from '../lib/client'
import {
  appendRepeaterRow,
  fieldInputType,
  removeRepeaterRow,
  repeaterRows,
  sectionStorageKey,
  updateRepeaterRow
} from '../lib/formSchema'
import { formatDateTime, profileName } from '../lib/format'
import { useAsync } from '../lib/useAsync'
import type { ClientWorkspacePayload, FormField, FormTemplate, PortalPayload } from '../lib/types'
import { useAuth } from '../app/auth'
import { Badge, Card, EmptyState, ErrorState, InlineNotice, LoadingState, PageSection } from '../components/ui'

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

export function Component() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [draftData, setDraftData] = useState<Record<string, unknown>>({})
  const [statusMessage, setStatusMessage] = useState('')

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

  useEffect(() => {
    if (!data || data.mode === 'empty') return
    const fallback = data.templates[0]?.id || ''
    setSelectedTemplateId((current) => current || fallback)
  }, [data])

  useEffect(() => {
    setDraftData({})
  }, [selectedTemplateId])

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
      setDraftData({})
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
        <Card className="section-card">
          <p className="eyebrow">{data.mode === 'client' ? 'Client workspace' : 'Secure portal'}</p>
          <h1>{data.profileName}</h1>
          <p className="muted">
            {data.mode === 'client'
              ? 'The client route is now a first-class screen instead of a nav item that falls through to placeholder text.'
              : 'Shared portal sessions now resolve through the routed app instead of a standalone fallback page.'}
          </p>
          {statusMessage ? <InlineNotice tone="info">{statusMessage}</InlineNotice> : null}
        </Card>

        <div className="split-grid">
          <PageSection title="Progress" subtitle="See what is complete, in draft, or still waiting.">
            {data.progress.length ? (
              <div className="compact-stack">
                {data.progress.map((entry, index) => (
                  <div key={`progress-${index}`} className="row-between">
                    <span>{String(entry.templateName || entry.templateId || `Template ${index + 1}`)}</span>
                    <Badge
                      tone={
                        String(entry.status) === 'submitted'
                          ? 'success'
                          : String(entry.status) === 'draft'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {String(entry.status || 'not_started')}
                    </Badge>
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
                      <Badge tone={submission.status === 'submitted' ? 'success' : 'warning'}>
                        {submission.status}
                      </Badge>
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
                <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
                  {data.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedTemplate ? (
                <div className="compact-stack">
                  {selectedTemplate.sections.map((section, sectionIndex) => {
                    if (section.repeatable) {
                      const rows = repeaterRows(draftData, section, sectionIndex)
                      return (
                        <Card key={sectionStorageKey(section, sectionIndex)} className="section-card inset-card">
                          <div className="row-between">
                            <div>
                              <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
                              <p className="muted">Add repeatable entries as needed.</p>
                            </div>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() =>
                                setDraftData((current) => appendRepeaterRow(current, section, sectionIndex))
                              }
                            >
                              Add row
                            </button>
                          </div>
                          {rows.length ? (
                            rows.map((row, rowIndex) => {
                              const rowObject = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
                              return (
                                <Card
                                  key={`${sectionStorageKey(section, sectionIndex)}-${rowIndex}`}
                                  className="section-card inset-card"
                                >
                                  <div className="row-between">
                                    <strong>Row {rowIndex + 1}</strong>
                                    <button
                                      type="button"
                                      className="ghost-button"
                                      onClick={() =>
                                        setDraftData((current) =>
                                          removeRepeaterRow(current, section, sectionIndex, rowIndex)
                                        )
                                      }
                                    >
                                      Remove
                                    </button>
                                  </div>
                                  <div className="form-grid two-up">
                                    {(section.fields || []).map((field) =>
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
                      <Card key={sectionStorageKey(section, sectionIndex)} className="section-card inset-card">
                        <h3>{section.title || `Section ${sectionIndex + 1}`}</h3>
                        <div className="form-grid two-up">
                          {(section.fields || []).map((field) =>
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
                  })}
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
