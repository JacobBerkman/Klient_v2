import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api, routes } from '../lib/client'
import { formatDateTime, profileName } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type {
  DocumentTemplate,
  FormTemplate,
  FormSubmission,
  MappingRow,
  Profile,
  TemplateAutoMapPayload,
  TemplateMappingPathGroup,
  TemplateMappingPathsPayload,
  TemplatePreviewPayload,
  TemplateVersion,
  TemplateVersionComparePayload
} from '../lib/types'
import { useAuth } from '../app/auth'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useToast } from '../components/toast'
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  LoadingState,
  PageHero,
  PageSection,
  StatusBadge
} from '../components/ui'
import { SourcePathPicker } from '../components/SourcePathPicker'

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
  formTemplates: FormTemplate[]
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

function fieldMeta(field: Record<string, unknown> | string, key: string) {
  return field && typeof field === 'object' && !Array.isArray(field) ? field[key] : undefined
}

function fieldName(field: Record<string, unknown> | string) {
  return String(fieldMeta(field, 'fieldName') || field)
}

function validationPreviewFromError(error: unknown): TemplatePreviewPayload | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') return null
  const details = error.details as Record<string, unknown>
  const issues = Array.isArray(details.issues) ? (details.issues as Array<Record<string, unknown>>) : []
  if (!issues.length) return null
  return {
    issues,
    publishReadiness:
      details.publishReadiness && typeof details.publishReadiness === 'object'
        ? (details.publishReadiness as TemplatePreviewPayload['publishReadiness'])
        : {
            summary: {
              status: 'blocked',
              blockersCount: issues.length,
              warningsCount: 0
            }
          }
  }
}

export function Component() {
  const { templateId = '' } = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [preview, setPreview] = useState<TemplatePreviewPayload | null>(null)
  const [comparePayload, setComparePayload] = useState<TemplateVersionComparePayload | null>(null)
  const [selection, setSelection] = useState({ clientId: '', submissionId: '' })
  const [publishForm, setPublishForm] = useState({ versionBump: '', changelog: '' })
  const [compareSelection, setCompareSelection] = useState({ baseVersion: '', targetVersion: '' })
  const [revertSelection, setRevertSelection] = useState({ targetVersion: '', changelog: '' })
  const [confirmingRevert, setConfirmingRevert] = useState(false)
  const [reverting, setReverting] = useState(false)
  // Grouped source-path catalog for the mapping picker; fetched once per template.
  // null = still loading or unavailable (picker falls back to free-text entry).
  const [mappingPathGroups, setMappingPathGroups] = useState<TemplateMappingPathGroup[] | null>(null)
  const [autoMapping, setAutoMapping] = useState(false)
  // Freshest template payload returned by auto-map; cleared on the next full refetch
  // so the canonical list response wins again.
  const [templateOverride, setTemplateOverride] = useState<DocumentTemplate | null>(null)

  const { data, error, loading } = useAsync<TemplateDetailData>(async () => {
    const [templates, versions, transitions, profiles, submissions, formTemplates] = await Promise.all([
      api.get<DocumentTemplate[]>(routes.documentTemplates()),
      api.get<TemplateVersion[]>(routes.documentTemplateVersions(templateId)),
      api.get<Array<Record<string, unknown>>>(routes.documentTemplatePublishTransitions(templateId)),
      api.get<Profile[]>(routes.profiles({ kind: 'client' })),
      api.get<FormSubmission[]>(routes.formSubmissions()),
      api.get<FormTemplate[]>(routes.formTemplates())
    ])
    return { templates, versions, transitions, profiles, submissions, formTemplates }
  }, [templateId, refreshKey])

  const template =
    (templateOverride && templateOverride.id === templateId ? templateOverride : null) ||
    data?.templates.find((entry) => entry.id === templateId) ||
    null
  const linkedForm = data?.formTemplates.find((entry) => entry.id === template?.linkedFormTemplateId) || null
  const extractionFields = template?.extraction?.fields?.length
    ? template.extraction.fields
    : template?.extractedFields || []
  const extractionDiagnostics = template?.extraction?.diagnostics || []

  useEffect(() => {
    if (!template) return
    setMappings((template.mappings || []).length ? template.mappings : [emptyMapping()])
  }, [template?.id, template?.updatedAt, template?.versionHash])

  // Fetch the grouped source-path catalog once per template. Failure is
  // non-fatal: the picker degrades to free-text entry.
  useEffect(() => {
    let cancelled = false
    setMappingPathGroups(null)
    if (!templateId) return
    void api
      .get<TemplateMappingPathsPayload>(routes.templateMappingPaths(templateId))
      .then((payload) => {
        if (!cancelled) setMappingPathGroups(payload.groups || [])
      })
      .catch(() => {
        // Leave null so the picker advertises manual entry.
      })
    return () => {
      cancelled = true
    }
  }, [templateId])

  function refreshTemplateData() {
    setTemplateOverride(null)
    setRefreshKey((value) => value + 1)
  }

  const submissionsForSelection = useMemo(
    () =>
      (data?.submissions || []).filter(
        (entry) => (!selection.clientId || entry.clientId === selection.clientId) && entry.templateId !== templateId
      ),
    [data?.submissions, selection.clientId, templateId]
  )
  const requiredMappingFields = extractionFields.map((field) => fieldName(field)).filter(Boolean)
  const mappedPdfFields = new Set(mappings.map((mapping) => String(mapping.pdfField || '').trim()).filter(Boolean))
  const missingMappingFields = requiredMappingFields.filter((name) => !mappedPdfFields.has(name))
  const mappingReadinessStatus = missingMappingFields.length ? 'missing required mappings' : 'complete mappings'
  // A field is unmapped when it has no row, an empty sourcePath, or a sourcePath
  // that just echoes its own field key (the auto-build placeholder).
  const unmappedFieldCount = requiredMappingFields.filter((name) => {
    const row = mappings.find((entry) => String(entry.pdfField || '').trim() === name)
    const sourcePath = String(row?.sourcePath || '').trim()
    return !row || !sourcePath || sourcePath === name
  }).length

  async function handleSaveMappings() {
    if (!template) return
    try {
      await api.post(routes.documentTemplateMappings(template.id), {
        mappings,
        expectedVersionHash: template.versionHash
      })
      setStatusMessage('Mappings saved.')
      refreshTemplateData()
    } catch (saveError) {
      const validationPreview = validationPreviewFromError(saveError)
      if (validationPreview) {
        setPreview(validationPreview)
        setStatusMessage(
          `Mapping save failed with ${validationPreview.issues?.length || 0} validation issue${
            validationPreview.issues?.length === 1 ? '' : 's'
          }.`
        )
      } else {
        setStatusMessage(saveError instanceof Error ? saveError.message : 'Mapping save failed.')
      }
    }
  }

  async function handleAutoMap() {
    if (!template || autoMapping) return
    setAutoMapping(true)
    try {
      const payload = await api.post<TemplateAutoMapPayload>(routes.templateAutoMap(template.id), {})
      setTemplateOverride(payload.template)
      toast.success(`Auto-mapped ${payload.applied} of ${payload.total} fields`)
    } catch (autoMapError) {
      toast.error(autoMapError instanceof Error ? autoMapError.message : 'Auto-map failed.')
    } finally {
      setAutoMapping(false)
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
      await api.post(routes.documentTemplatePublish(template.id), {
        versionBump: publishForm.versionBump,
        changelog: publishForm.changelog,
        clientId: selection.clientId || undefined,
        submissionId: selection.submissionId || undefined
      })
      toast.success('Template published.')
      refreshTemplateData()
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
      toast.error(publishError instanceof Error ? publishError.message : 'Publish failed.')
    }
  }

  async function handleQueueExport(type: 'pdf' | 'xlsx') {
    if (!template || !selection.clientId) return
    try {
      await api.post(routes.exports(), {
        templateId: template.id,
        clientId: selection.clientId,
        submissionId: selection.submissionId || undefined,
        type
      })
      setStatusMessage(`${type.toUpperCase()} export queued.`)
    } catch (exportError) {
      setStatusMessage(exportError instanceof Error ? exportError.message : 'Export queue failed.')
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

  async function handleRevert() {
    if (!template) return
    setReverting(true)
    try {
      await api.post(routes.documentTemplateRevert(template.id), {
        targetVersion: Number(revertSelection.targetVersion),
        changelog: revertSelection.changelog
      })
      setRevertSelection({ targetVersion: '', changelog: '' })
      toast.success('Template reverted.')
      refreshTemplateData()
    } catch (revertError) {
      toast.error(revertError instanceof Error ? revertError.message : 'Revert failed.')
    } finally {
      setConfirmingRevert(false)
      setReverting(false)
    }
  }

  if (loading) return <LoadingState label="Loading template" />
  if (error || !data) return <ErrorState title="Template detail failed to load." detail={error?.message} />
  if (!template)
    return (
      <ErrorState
        title="Template not found."
        detail="The requested template is missing from the canonical template list."
      />
    )

  return (
    <div className="stack">
      <PageHero
        eyebrow="Template editor"
        title={template.name}
        subtitle="Preview mappings, publish with a changelog, compare versions, and revert from a dedicated editor route."
        meta={
          <>
            <StatusBadge status={template.publishState || 'draft'} />
            <StatusBadge status={`${template.mappings.length} mappings`} />
            <StatusBadge status={`${data.versions.length} versions`} />
            <StatusBadge status={template.exportReadiness?.status || 'export readiness unknown'} />
          </>
        }
      />
      <PageSection
        title="Source and generated form"
        subtitle="Auto-build output is visible here: source artifact, extracted fields, linked form, and export readiness."
      >
        <div className="detail-grid">
          <Card className="section-card">
            <h3>Source PDF</h3>
            <div className="compact-stack">
              <p className="muted">
                File: {template.sourceArtifact?.fileName || template.fileName || 'No source artifact'}
              </p>
              <p className="muted">Content type: {template.sourceArtifact?.contentType || 'Not persisted'}</p>
              <p className="muted">
                Size: {template.sourceArtifact?.sizeBytes ? `${template.sourceArtifact.sizeBytes} bytes` : 'Unknown'}
              </p>
              <p className="muted">Object key: {template.sourceArtifact?.key || 'Unavailable'}</p>
              <p className="muted">Checksum: {template.sourceArtifact?.checksum || 'Unavailable'}</p>
              <StatusBadge status={template.sourceArtifact ? 'source pdf persisted' : 'summary fallback only'} />
              <StatusBadge
                status={template.sourceArtifact ? 'template-driven filled PDF' : 'fallback summary export'}
              />
              {template.sourceArtifact ? (
                <Link className="text-link" to={`/templates/${template.id}/mapper`}>
                  Open visual mapper
                </Link>
              ) : null}
            </div>
          </Card>

          <Card className="section-card">
            <h3>Extraction readiness</h3>
            <div className="compact-stack">
              <StatusBadge status={template.extraction?.status || 'unknown'} />
              <StatusBadge status={`${extractionFields.length} fields`} />
              <StatusBadge status={`${template.autoBuildSummary?.repeatableSectionCount || 0} repeaters`} />
              <StatusBadge status={template.exportReadiness?.status || 'not assessed'} />
              {template.extraction?.error?.message ? (
                <InlineNotice tone="warning">{template.extraction.error.message}</InlineNotice>
              ) : null}
            </div>
          </Card>

          <Card className="section-card">
            <h3>Linked form template</h3>
            {linkedForm ? (
              <div className="compact-stack">
                <Link className="text-link" to={`/forms?templateId=${linkedForm.id}`}>
                  {linkedForm.name}
                </Link>
                <p className="muted">Form template ID: {linkedForm.id}</p>
                <p className="muted">Source document ID: {linkedForm.generatedFromDocumentTemplateId || template.id}</p>
                <p className="muted">Sections: {linkedForm.sections.length}</p>
                <p className="muted">Generated from: {linkedForm.generation?.source || 'auto-build'}</p>
                <p className="muted">
                  Generation summary: {linkedForm.generation?.fieldCount || 0} fields,{' '}
                  {linkedForm.generation?.repeatableSectionCount || 0} repeaters
                </p>
              </div>
            ) : (
              <EmptyState
                title="No linked form generated."
                detail="Failed or manually created templates can still use summary fallback exports when explicitly supported."
              />
            )}
          </Card>
        </div>

        {extractionDiagnostics.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Diagnostic</th>
                  <th>Severity</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {extractionDiagnostics.map((diagnostic, index) => (
                  <tr key={`diagnostic-${index}`}>
                    <td>{String(diagnostic.code || diagnostic.reasonCode || 'diagnostic')}</td>
                    <td>{String(diagnostic.severity || 'info')}</td>
                    <td>{String(diagnostic.message || 'No message')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </PageSection>

      <PageSection
        title={template.name}
        subtitle={`${template.publishState || 'draft'} template. Updated ${formatDateTime(template.updatedAt || template.createdAt)}.`}
      >
        <div className="detail-grid">
          <Card className="section-card">
            <h3>Status</h3>
            <div className="compact-stack">
              <StatusBadge status={template.publishState || 'draft'} />
              <p className="muted">File: {template.fileName}</p>
              <p className="muted">Version count: {data.versions.length}</p>
              <p className="muted">Mappings: {template.mappings.length}</p>
            </div>
          </Card>

          <Card className="section-card">
            <h3>Publish and export controls</h3>
            <div className="compact-stack">
              <button type="button" onClick={() => void handlePreviewMappings()}>
                Run preview
              </button>
              <Field label="Version bump">
                <input
                  value={publishForm.versionBump}
                  onChange={(event) => setPublishForm((current) => ({ ...current, versionBump: event.target.value }))}
                  placeholder="1.0.0"
                />
              </Field>
              <Field label="Publish changelog">
                <textarea
                  rows={3}
                  value={publishForm.changelog}
                  onChange={(event) => setPublishForm((current) => ({ ...current, changelog: event.target.value }))}
                  placeholder="Describe this publish."
                />
              </Field>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handlePublish()}
                disabled={!hasGuard(user, 'canPublishTemplate')}
              >
                Publish template
              </button>
              <div className="actions-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleQueueExport('pdf')}
                  disabled={!selection.clientId || !hasGuard(user, 'canWriteExports')}
                >
                  Queue PDF
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleQueueExport('xlsx')}
                  disabled={!selection.clientId || !hasGuard(user, 'canWriteExports')}
                >
                  Queue XLSX
                </button>
              </div>
              <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
                {statusMessage || 'Choose a client in Preview before queuing a template-driven export.'}
              </p>
            </div>
          </Card>
        </div>
      </PageSection>

      <div className="split-grid">
        <PageSection
          title="Extracted fields"
          subtitle="AcroForm fields remain visible so mappings can be reviewed against the uploaded PDF."
        >
          {extractionFields.length ? (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Type</th>
                    <th>Page</th>
                    <th>Required</th>
                    <th>Read only</th>
                  </tr>
                </thead>
                <tbody>
                  {extractionFields.map((field, index) => (
                    <tr key={`${fieldName(field)}-${index}`}>
                      <td>{fieldName(field)}</td>
                      <td>{String(fieldMeta(field, 'fieldType') || 'text')}</td>
                      <td>
                        {fieldMeta(field, 'pageIndex') === null || fieldMeta(field, 'pageIndex') === undefined
                          ? 'Unknown'
                          : Number(fieldMeta(field, 'pageIndex')) + 1}
                      </td>
                      <td>{fieldMeta(field, 'required') ? 'Yes' : 'No'}</td>
                      <td>{fieldMeta(field, 'readOnly') ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No extracted fields."
              detail="Upload a fillable AcroForm PDF through Auto-build to populate this table."
            />
          )}
        </PageSection>

        <PageSection
          title="Mappings"
          subtitle="Edit source paths, transforms, and repeater selectors without returning to the shell."
          action={
            <button
              type="button"
              className="secondary-button"
              data-testid="auto-map-button"
              onClick={() => void handleAutoMap()}
              disabled={autoMapping || !hasGuard(user, 'canEditTemplate')}
              aria-busy={autoMapping}
            >
              {autoMapping ? 'Auto-mapping...' : 'Auto-map fields'}
            </button>
          }
        >
          <div className="section-toolbar">
            <StatusBadge status={mappingReadinessStatus} />
            <StatusBadge status={`${requiredMappingFields.length} required PDF fields`} />
            <StatusBadge status={`${missingMappingFields.length} missing`} />
            <span data-testid="unmapped-count-badge">
              <Badge tone={unmappedFieldCount ? 'warning' : 'success'}>
                {unmappedFieldCount
                  ? `${unmappedFieldCount} field${unmappedFieldCount === 1 ? '' : 's'} unmapped`
                  : 'all fields mapped'}
              </Badge>
            </span>
          </div>
          {missingMappingFields.length ? (
            <InlineNotice tone="warning">
              Missing required mappings: {missingMappingFields.slice(0, 6).join(', ')}
              {missingMappingFields.length > 6 ? `, and ${missingMappingFields.length - 6} more` : ''}.
            </InlineNotice>
          ) : (
            <InlineNotice tone="success">
              Every extracted PDF field has a mapping row. Save will still validate transforms and repeater paths.
            </InlineNotice>
          )}
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
                      <SourcePathPicker
                        value={String(mapping.sourcePath || '')}
                        onChange={(nextValue) =>
                          setMappings((current) =>
                            current.map((entry, rowIndex) =>
                              rowIndex === index ? { ...entry, sourcePath: nextValue } : entry
                            )
                          )
                        }
                        groups={mappingPathGroups}
                        label={`Source path for ${String(mapping.pdfField || '').trim() || `row ${index + 1}`}`}
                        inputTestId={`mapping-source-path-${index}`}
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
            <button
              type="button"
              className="secondary-button"
              onClick={() => setMappings((current) => [...current, emptyMapping()])}
            >
              Add row
            </button>
            <button
              type="button"
              onClick={() => void handleSaveMappings()}
              disabled={!hasGuard(user, 'canEditTemplate')}
            >
              Save mappings
            </button>
          </div>
        </PageSection>

        <PageSection
          title="Preview"
          subtitle="Run current mappings against a client or submission to surface blockers before publish."
        >
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              void handlePreviewMappings()
            }}
          >
            <label>
              <span>Client</span>
              <select
                value={selection.clientId}
                onChange={(event) =>
                  setSelection((current) => ({ ...current, clientId: event.target.value, submissionId: '' }))
                }
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
                    {submission.templateId} -{' '}
                    {profileName(data.profiles.find((entry) => entry.id === submission.clientId))}
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
                        <th>Field</th>
                        <th>Target</th>
                        <th>Message</th>
                        <th>Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.issues.map((issue, index) => (
                        <tr key={`issue-${index}`}>
                          <td>{String(issue.code || issue.errorCode || 'issue')}</td>
                          <td>{String(issue.field || '-')}</td>
                          <td>
                            {String(
                              (issue.meta as Record<string, unknown> | undefined)?.requiredPdfField ||
                                (issue.meta as Record<string, unknown> | undefined)?.fieldKey ||
                                issue.path ||
                                '-'
                            )}
                          </td>
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
            <EmptyState
              title="No preview yet."
              detail="Pick a client or submission, then run preview to inspect publish readiness."
            />
          )}
        </PageSection>
      </div>

      <div className="split-grid">
        <PageSection
          title="Version history"
          subtitle="Inspect versions and compare changes before publishing or reverting."
        >
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
            <EmptyState
              title="No versions available."
              detail="Version history will appear here after the template lifecycle begins."
            />
          )}
        </PageSection>

        <PageSection
          title="Compare and revert"
          subtitle="Use the current backend versioning behavior without replatforming the template runtime."
        >
          <form className="form-grid" onSubmit={handleCompareVersions}>
            <label>
              <span>Base version</span>
              <select
                value={compareSelection.baseVersion}
                onChange={(event) =>
                  setCompareSelection((current) => ({ ...current, baseVersion: event.target.value }))
                }
                required
              >
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
              <select
                value={compareSelection.targetVersion}
                onChange={(event) =>
                  setCompareSelection((current) => ({ ...current, targetVersion: event.target.value }))
                }
                required
              >
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
                Versions {comparePayload.baseVersion} to {comparePayload.targetVersion}:{' '}
                {comparePayload.changed ? 'changed' : 'no change'}
              </p>
              <pre className="json-block">{JSON.stringify(comparePayload.diff, null, 2)}</pre>
            </Card>
          ) : null}

          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              setConfirmingRevert(true)
            }}
          >
            <label>
              <span>Revert to version</span>
              <select
                value={revertSelection.targetVersion}
                onChange={(event) =>
                  setRevertSelection((current) => ({ ...current, targetVersion: event.target.value }))
                }
                required
              >
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
              <textarea
                rows={3}
                value={revertSelection.changelog}
                onChange={(event) => setRevertSelection((current) => ({ ...current, changelog: event.target.value }))}
                required
              />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Revert version
            </button>
          </form>
          <ConfirmDialog
            open={confirmingRevert}
            title={`Revert to version ${revertSelection.targetVersion}?`}
            description="Reverting replaces the current mappings with the selected version's snapshot and records a new version entry with your changelog."
            confirmLabel="Confirm revert"
            tone="danger"
            busy={reverting}
            onConfirm={() => void handleRevert()}
            onCancel={() => setConfirmingRevert(false)}
          />

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
