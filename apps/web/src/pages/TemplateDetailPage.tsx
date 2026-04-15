import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiError, api, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type {
  DocumentTemplate,
  FormSubmission,
  MappingRow,
  Profile,
  TemplatePreviewPayload,
  TemplateVersion,
  TemplateVersionComparePayload
} from '../lib/types'
import { useAuth } from '../app/auth'
import { Badge, Card, EmptyState, ErrorState, InlineNotice, LoadingState, PageSection } from '../components/ui'

export const handle = {
  title: ({ templateId }: Record<string, string | undefined>) => `Template ${templateId || ''}`.trim(),
  subtitle: 'Mappings, preview, version history, publish, compare, and revert all live on a dedicated route.',
  breadcrumb: 'Template detail'
}

interface TemplateDetailData {
  templates: DocumentTemplate[]
  versions: TemplateVersion[]
  transitions: Array<Record<string, unknown>>
  profiles: Profile[]
  submissions: FormSubmission[]
}

function emptyMapping(): MappingRow {
  return {
    pdfField: '',
    fieldLabel: '',
    sourcePath: '',
    repeaterPath: '',
    required: false,
    transformType: '',
    transformExpression: ''
  }
}

export function Component() {
  const { templateId = '' } = useParams()
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [preview, setPreview] = useState<TemplatePreviewPayload | null>(null)
  const [comparePayload, setComparePayload] = useState<TemplateVersionComparePayload | null>(null)
  const [selection, setSelection] = useState({ clientId: '', submissionId: '' })
  const [compareSelection, setCompareSelection] = useState({ baseVersion: '', targetVersion: '' })
  const [revertSelection, setRevertSelection] = useState({ targetVersion: '', changelog: '' })

  const { data, error, loading } = useAsync<TemplateDetailData>(
    async () => {
      const [templates, versions, transitions, profiles, submissions] = await Promise.all([
        api.get<DocumentTemplate[]>(routes.documentTemplates()),
        api.get<TemplateVersion[]>(routes.documentTemplateVersions(templateId)),
        api.get<Array<Record<string, unknown>>>(routes.documentTemplatePublishTransitions(templateId)),
        api.get<Profile[]>(routes.profiles({ kind: 'client' })),
        api.get<FormSubmission[]>(routes.formSubmissions())
      ])
      return { templates, versions, transitions, profiles, submissions }
    },
    [templateId, refreshKey]
  )

  const template = data?.templates.find((entry) => entry.id === templateId) || null

  useEffect(() => {
    if (!template) return
    setMappings((template.mappings || []).length ? template.mappings : [emptyMapping()])
  }, [template?.id, template?.updatedAt, template?.versionHash])

  const submissionsForSelection = useMemo(
    () =>
      (data?.submissions || []).filter(
        (entry) => (!selection.clientId || entry.clientId === selection.clientId) && entry.templateId !== templateId
      ),
    [data?.submissions, selection.clientId, templateId]
  )

  async function handleSaveMappings() {
    if (!template) return
    try {
      await api.post(routes.documentTemplateMappings(template.id), {
        mappings,
        expectedVersionHash: template.versionHash
      })
      setStatusMessage('Mappings saved.')
      setRefreshKey((value) => value + 1)
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Mapping save failed.')
    }
  }

  async function handlePreviewMappings() {
    if (!template) return
    try {
      const payload = await api.post<TemplatePreviewPayload>(routes.documentTemplateMappingsPreview(template.id), {
        clientId: selection.clientId || undefined,
        submissionId: selection.submissionId || undefined
      })
      setPreview(payload)
      setStatusMessage('Preview generated.')
    } catch (previewError) {
      setStatusMessage(previewError instanceof Error ? previewError.message : 'Preview failed.')
    }
  }

  async function handlePublish() {
    if (!template) return
    try {
      await api.post(routes.documentTemplatePublish(template.id), {})
      setStatusMessage('Template published.')
      setRefreshKey((value) => value + 1)
    } catch (publishError) {
      if (publishError instanceof ApiError && publishError.details && typeof publishError.details === 'object') {
        const details = publishError.details as Record<string, unknown>
        if (details.publishReadiness && typeof details.publishReadiness === 'object') {
          setPreview({
            issues: Array.isArray(details.issues) ? (details.issues as Array<Record<string, unknown>>) : [],
            publishReadiness: details.publishReadiness as TemplatePreviewPayload['publishReadiness']
          })
        }
      }
      setStatusMessage(publishError instanceof Error ? publishError.message : 'Publish failed.')
    }
  }

  async function handleCompareVersions(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!template) return
    try {
      const payload = await api.get<TemplateVersionComparePayload>(
        routes.documentTemplateCompare(template.id, {
          baseVersion: compareSelection.baseVersion,
          targetVersion: compareSelection.targetVersion
        })
      )
      setComparePayload(payload)
      setStatusMessage('Version comparison loaded.')
    } catch (compareError) {
      setStatusMessage(compareError instanceof Error ? compareError.message : 'Compare failed.')
    }
  }

  async function handleRevert(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!template) return
    try {
      await api.post(routes.documentTemplateRevert(template.id), {
        targetVersion: Number(revertSelection.targetVersion),
        changelog: revertSelection.changelog
      })
      setRevertSelection({ targetVersion: '', changelog: '' })
      setStatusMessage('Template reverted.')
      setRefreshKey((value) => value + 1)
    } catch (revertError) {
      setStatusMessage(revertError instanceof Error ? revertError.message : 'Revert failed.')
    }
  }

  if (loading) return <LoadingState label="Loading template" />
  if (error || !data) return <ErrorState title="Template detail failed to load." detail={error?.message} />
  if (!template) return <ErrorState title="Template not found." detail="The requested template is missing from the canonical template list." />

  return (
    <div className="stack">
      <PageSection
        title={template.name}
        subtitle={`${template.publishState || 'draft'} template. Updated ${formatDateTime(template.updatedAt || template.createdAt)}.`}
      >
        <div className="detail-grid">
          <Card className="section-card">
            <h3>Status</h3>
            <div className="compact-stack">
              <Badge tone={template.publishState === 'published' ? 'success' : 'warning'}>
                {template.publishState || 'draft'}
              </Badge>
              <p className="muted">File: {template.fileName}</p>
              <p className="muted">Version count: {data.versions.length}</p>
              <p className="muted">Mappings: {template.mappings.length}</p>
            </div>
          </Card>

          <Card className="section-card">
            <h3>Publish controls</h3>
            <div className="compact-stack">
              <button type="button" onClick={() => void handlePreviewMappings()}>
                Run preview
              </button>
              <button type="button" className="secondary-button" onClick={() => void handlePublish()} disabled={!hasGuard(user, 'canPublishTemplate')}>
                Publish template
              </button>
              <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
                {statusMessage || 'Preview and publish now live on a dedicated editor route.'}
              </p>
            </div>
          </Card>
        </div>
      </PageSection>

      <div className="split-grid">
        <PageSection title="Mappings" subtitle="Edit source paths, transforms, and repeater selectors without returning to the shell.">
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>PDF field</th>
                  <th>Label</th>
                  <th>Source path</th>
                  <th>Repeater path</th>
                  <th>Transform</th>
                  <th>Expression</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping, index) => (
                  <tr key={`mapping-${index}`}>
                    <td>
                      <input
                        value={String(mapping.pdfField || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, pdfField: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(mapping.fieldLabel || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, fieldLabel: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(mapping.sourcePath || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, sourcePath: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(mapping.repeaterPath || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, repeaterPath: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(mapping.transformType || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, transformType: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={String(mapping.transformExpression || '')}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, transformExpression: event.target.value } : entry
                            )
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(mapping.required)}
                        onChange={(event) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, required: event.target.checked } : entry
                            )
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions-row">
            <button type="button" className="secondary-button" onClick={() => setMappings((current) => [...current, emptyMapping()])}>
              Add row
            </button>
            <button type="button" onClick={() => void handleSaveMappings()} disabled={!hasGuard(user, 'canEditTemplate')}>
              Save mappings
            </button>
          </div>
        </PageSection>

        <PageSection title="Preview" subtitle="Run current mappings against a client or submission to surface blockers before publish.">
          <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void handlePreviewMappings() }}>
            <label>
              <span>Client</span>
              <select
                value={selection.clientId}
                onChange={(event) => setSelection((current) => ({ ...current, clientId: event.target.value, submissionId: '' }))}
              >
                <option value="">Select a client</option>
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profileName(profile)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Submission</span>
              <select
                value={selection.submissionId}
                onChange={(event) => setSelection((current) => ({ ...current, submissionId: event.target.value }))}
              >
                <option value="">Optional submission</option>
                {submissionsForSelection.map((submission) => (
                  <option key={submission.id} value={submission.id}>
                    {submission.templateId} - {profileName(data.profiles.find((entry) => entry.id === submission.clientId))}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Generate preview</button>
          </form>

          {preview ? (
            <div className="compact-stack">
              <Card className="section-card inset-card">
                <h3>Readiness</h3>
                <p className="muted">
                  Status: {String(preview.publishReadiness?.summary?.status || 'unknown')} | blockers{' '}
                  {String(preview.publishReadiness?.summary?.blockersCount || 0)} | warnings{' '}
                  {String(preview.publishReadiness?.summary?.warningsCount || 0)}
                </p>
              </Card>
              {preview.issues?.length ? (
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Message</th>
                        <th>Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.issues.map((issue, index) => (
                        <tr key={`issue-${index}`}>
                          <td>{String(issue.code || issue.errorCode || 'issue')}</td>
                          <td>{String(issue.message || issue.errorMessage || 'Validation issue')}</td>
                          <td>{String(issue.severity || 'error')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <InlineNotice tone="success">No validation issues were returned by the preview endpoint.</InlineNotice>
              )}
            </div>
          ) : (
            <EmptyState title="No preview yet." detail="Pick a client or submission, then run preview to inspect publish readiness." />
          )}
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection title="Version history" subtitle="Inspect versions and compare changes before publishing or reverting.">
          {data.versions.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Event</th>
                    <th>State</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.versions.map((version) => (
                    <tr key={version.version}>
                      <td>{version.version}</td>
                      <td>{version.event || 'updated'}</td>
                      <td>{version.publishState || 'draft'}</td>
                      <td>{formatDateTime(version.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No versions available." detail="Version history will appear here after the template lifecycle begins." />
          )}
        </PageSection>

        <PageSection title="Compare and revert" subtitle="Use the current backend versioning behavior without replatforming the template runtime.">
          <form className="form-grid" onSubmit={handleCompareVersions}>
            <label>
              <span>Base version</span>
              <select value={compareSelection.baseVersion} onChange={(event) => setCompareSelection((current) => ({ ...current, baseVersion: event.target.value }))} required>
                <option value="">Select</option>
                {data.versions.map((version) => (
                  <option key={`base-${version.version}`} value={version.version}>
                    {version.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Target version</span>
              <select value={compareSelection.targetVersion} onChange={(event) => setCompareSelection((current) => ({ ...current, targetVersion: event.target.value }))} required>
                <option value="">Select</option>
                {data.versions.map((version) => (
                  <option key={`target-${version.version}`} value={version.version}>
                    {version.version}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Compare versions</button>
          </form>

          {comparePayload ? (
            <Card className="section-card inset-card">
              <h3>Compare result</h3>
              <p className="muted">
                Versions {comparePayload.baseVersion} to {comparePayload.targetVersion}: {comparePayload.changed ? 'changed' : 'no change'}
              </p>
              <pre className="json-block">{JSON.stringify(comparePayload.diff, null, 2)}</pre>
            </Card>
          ) : null}

          <form className="form-grid" onSubmit={handleRevert}>
            <label>
              <span>Revert to version</span>
              <select value={revertSelection.targetVersion} onChange={(event) => setRevertSelection((current) => ({ ...current, targetVersion: event.target.value }))} required>
                <option value="">Select</option>
                {data.versions.map((version) => (
                  <option key={`revert-${version.version}`} value={version.version}>
                    {version.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Changelog</span>
              <textarea rows={3} value={revertSelection.changelog} onChange={(event) => setRevertSelection((current) => ({ ...current, changelog: event.target.value }))} required />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Revert version
            </button>
          </form>

          {data.transitions.length ? (
            <Card className="section-card inset-card">
              <h3>Publish transitions</h3>
              <pre className="json-block">{JSON.stringify(data.transitions, null, 2)}</pre>
            </Card>
          ) : null}
        </PageSection>
      </div>
    </div>
  )
}
