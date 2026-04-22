import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { DocumentTemplate } from '../lib/types'
import { useAuth } from '../app/auth'
import {
  ActionPanel,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  PageHero,
  PageSection,
  StatGroup,
  StatusBadge
} from '../components/ui'

export const handle = {
  title: 'Templates',
  subtitle: 'Document template lifecycle with mappings, versions, preview, publish, and auto-build entry points.',
  breadcrumb: 'Templates'
}

export function Component() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
  const [autoBuildResult, setAutoBuildResult] = useState<DocumentTemplate | null>(null)
  const [createForm, setCreateForm] = useState({
    name: '',
    fileName: 'template.pdf',
    extractedFields: 'firstName,lastName'
  })
  const [autoBuildName, setAutoBuildName] = useState('')
  const [autoBuildFile, setAutoBuildFile] = useState<File | null>(null)

  const { data, error, loading } = useAsync<DocumentTemplate[]>(() => api.get(routes.documentTemplates()), [refreshKey])

  async function handleCreateTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatusMessage('')
    try {
      await api.post(routes.documentTemplates(), {
        name: createForm.name,
        fileName: createForm.fileName,
        extractedFields: createForm.extractedFields
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        mappings: []
      })
      setCreateForm({ name: '', fileName: 'template.pdf', extractedFields: 'firstName,lastName' })
      setStatusMessage('Document template created.')
      setRefreshKey((value) => value + 1)
    } catch (createError) {
      setStatusMessage(createError instanceof Error ? createError.message : 'Template creation failed.')
    }
  }

  async function handleAutoBuild(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!autoBuildFile) {
      setStatusMessage('Choose a PDF file for auto-build.')
      return
    }
    setStatusMessage('')
    try {
      const bytes = Array.from(new Uint8Array(await autoBuildFile.arrayBuffer()))
      const built = await api.post<DocumentTemplate>(routes.documentTemplateAutoBuild(), {
        name: autoBuildName || autoBuildFile.name.replace(/\.pdf$/i, ''),
        fileName: autoBuildFile.name,
        fileBytes: bytes
      })
      setAutoBuildName('')
      setAutoBuildFile(null)
      setAutoBuildResult(built)
      setStatusMessage(
        built.extraction?.status === 'failed'
          ? built.extraction.error?.message || 'Auto-build completed with extraction errors.'
          : `Auto-build completed: ${built.autoBuildSummary?.fieldCount || built.extractedFields.length} fields, ${built.autoBuildSummary?.mappingCount || built.mappings.length} mappings.`
      )
      setRefreshKey((value) => value + 1)
    } catch (buildError) {
      setStatusMessage(buildError instanceof Error ? buildError.message : 'Auto-build failed.')
    }
  }

  if (loading) return <LoadingState label="Loading templates" />
  if (error || !data) return <ErrorState title="Templates failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <PageHero
        eyebrow="Template library"
        title="Build and publish documents without leaving the routed app"
        subtitle="Create, auto-build, map, preview, publish, revert, and export from dedicated template routes."
        actions={<ButtonLink to="/exports">Open exports</ButtonLink>}
      />

      <StatGroup>
        <MetricCard label="Templates" value={data.length} hint="Document-ready templates" />
        <MetricCard
          label="Published"
          value={data.filter((template) => template.publishState === 'published').length}
          hint="Ready for export use"
        />
        <MetricCard
          label="Draft"
          value={data.filter((template) => template.publishState !== 'published').length}
          hint="Still in editing or review"
        />
        <MetricCard
          label="Mappings"
          value={data.reduce((total, template) => total + (template.mappings?.length || 0), 0)}
          hint="Current mapped fields across the library"
        />
      </StatGroup>

      <div className="split-grid">
        <ActionPanel
          title="Create document template"
          subtitle="Seed a template manually when extracted fields are already known."
        >
          <form className="form-grid" onSubmit={handleCreateTemplate}>
            <Field label="Name">
              <input
                value={createForm.name}
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </Field>
            <Field label="File name">
              <input
                value={createForm.fileName}
                onChange={(event) => setCreateForm((current) => ({ ...current, fileName: event.target.value }))}
              />
            </Field>
            <Field label="Extracted fields" hint="Comma-separated field ids from the document.">
              <input
                value={createForm.extractedFields}
                onChange={(event) => setCreateForm((current) => ({ ...current, extractedFields: event.target.value }))}
              />
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Create template
            </button>
          </form>
        </ActionPanel>

        <ActionPanel
          title="Auto-build from PDF"
          subtitle="Upload a PDF and let the existing backend infer fields and mappings."
        >
          <form className="form-grid" onSubmit={handleAutoBuild}>
            <Field label="Template name">
              <input
                value={autoBuildName}
                onChange={(event) => setAutoBuildName(event.target.value)}
                placeholder="Optional override"
              />
            </Field>
            <Field label="PDF file">
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setAutoBuildFile(event.target.files?.[0] || null)}
                required
              />
            </Field>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Run auto-build
            </button>
          </form>
          <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
            {statusMessage || 'Auto-build stays intact, but now starts from a real templates screen.'}
          </p>
          {autoBuildResult ? (
            <Card className="section-card inset-card">
              <div className="row-between">
                <div>
                  <strong>{autoBuildResult.name}</strong>
                  <p className="muted">
                    {autoBuildResult.sourceArtifact
                      ? 'Source PDF persisted for template export.'
                      : 'No source PDF artifact linked.'}
                  </p>
                </div>
                <StatusBadge status={autoBuildResult.extraction?.status || 'completed'} />
              </div>
              <div className="pill-list">
                <StatusBadge status={`${autoBuildResult.autoBuildSummary?.fieldCount || 0} fields`} />
                <StatusBadge status={`${autoBuildResult.autoBuildSummary?.repeatableSectionCount || 0} repeaters`} />
                <StatusBadge status={autoBuildResult.exportReadiness?.status || 'export readiness unknown'} />
                {autoBuildResult.linkedFormTemplateId ? (
                  <StatusBadge status="Linked form generated" />
                ) : (
                  <StatusBadge status="No linked form" />
                )}
              </div>
              <p className="muted">Linked form: {autoBuildResult.linkedFormTemplateId || 'Unavailable'}</p>
              <p className="muted">Source key: {autoBuildResult.sourceArtifact?.key || 'Unavailable'}</p>
              {autoBuildResult.extraction?.diagnostics?.length ? (
                <p className="muted">
                  Diagnostics:{' '}
                  {autoBuildResult.extraction.diagnostics.map((entry) => String(entry.code || 'diagnostic')).join(', ')}
                </p>
              ) : null}
              <Link className="text-link" to={`/templates/${autoBuildResult.id}`}>
                Review generated template
              </Link>
            </Card>
          ) : null}
        </ActionPanel>
      </div>

      <PageSection
        title="Template library"
        subtitle="Every advertised template route now lands on a concrete editor or detail view."
      >
        {data.length ? (
          <div className="cards-grid">
            {data.map((template) => (
              <Card key={template.id} className="section-card">
                <div className="row-between">
                  <div>
                    <p className="eyebrow">Template</p>
                    <h3>{template.name}</h3>
                  </div>
                  <StatusBadge status={template.publishState || 'draft'} />
                </div>
                <p className="muted">File: {template.fileName}</p>
                <p className="muted">
                  Source artifact:{' '}
                  {template.sourceArtifact?.key
                    ? `${template.sourceArtifact.key} (${template.sourceArtifact.contentType || 'application/pdf'})`
                    : 'Not persisted'}
                </p>
                <div className="pill-list">
                  <StatusBadge status={template.extraction?.status || 'completed'} />
                  <StatusBadge status={template.exportReadiness?.status || 'summary_fallback'} />
                  {template.linkedFormTemplateId ? <StatusBadge status="Linked form" /> : null}
                </div>
                {template.extraction?.diagnostics?.length ? (
                  <p className="muted">
                    Diagnostics:{' '}
                    {template.extraction.diagnostics.map((entry) => String(entry.code || 'diagnostic')).join(', ')}
                  </p>
                ) : null}
                <p className="muted">
                  {template.mappings?.length || 0} mappings, {template.versions?.length || 0} versions
                </p>
                <p className="muted">Updated {formatDateTime(template.updatedAt || template.createdAt)}</p>
                <Link className="text-link" to={`/templates/${template.id}`}>
                  Open editor
                </Link>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No document templates yet."
            detail="Create one above or use auto-build to seed the first mapping set."
          />
        )}
      </PageSection>
    </div>
  )
}
