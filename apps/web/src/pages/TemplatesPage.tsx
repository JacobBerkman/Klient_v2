import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, routes } from '../lib/client'
import { formatDateTime } from '../lib/format'
import { hasGuard } from '../lib/permissions'
import { useAsync } from '../lib/useAsync'
import type { DocumentTemplate } from '../lib/types'
import { useAuth } from '../app/auth'
import { Badge, Card, EmptyState, ErrorState, LoadingState, MetricCard, PageSection } from '../components/ui'

export const handle = {
  title: 'Templates',
  subtitle: 'Document template lifecycle with mappings, versions, preview, publish, and auto-build entry points.',
  breadcrumb: 'Templates'
}

export function Component() {
  const { user } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)
  const [statusMessage, setStatusMessage] = useState('')
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
      await api.post(routes.documentTemplateAutoBuild(), {
        name: autoBuildName || autoBuildFile.name.replace(/\.pdf$/i, ''),
        fileName: autoBuildFile.name,
        fileBytes: bytes
      })
      setAutoBuildName('')
      setAutoBuildFile(null)
      setStatusMessage('Auto-build template created.')
      setRefreshKey((value) => value + 1)
    } catch (buildError) {
      setStatusMessage(buildError instanceof Error ? buildError.message : 'Auto-build failed.')
    }
  }

  if (loading) return <LoadingState label="Loading templates" />
  if (error || !data) return <ErrorState title="Templates failed to load." detail={error?.message} />

  return (
    <div className="stack">
      <div className="metrics-grid">
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
      </div>

      <div className="split-grid">
        <Card className="section-card">
          <h3>Create document template</h3>
          <form className="form-grid" onSubmit={handleCreateTemplate}>
            <label>
              <span>Name</span>
              <input
                value={createForm.name}
                onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </label>
            <label>
              <span>File name</span>
              <input
                value={createForm.fileName}
                onChange={(event) => setCreateForm((current) => ({ ...current, fileName: event.target.value }))}
              />
            </label>
            <label>
              <span>Extracted fields</span>
              <input
                value={createForm.extractedFields}
                onChange={(event) => setCreateForm((current) => ({ ...current, extractedFields: event.target.value }))}
              />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Create template
            </button>
          </form>
        </Card>

        <Card className="section-card">
          <h3>Auto-build from PDF</h3>
          <form className="form-grid" onSubmit={handleAutoBuild}>
            <label>
              <span>Template name</span>
              <input
                value={autoBuildName}
                onChange={(event) => setAutoBuildName(event.target.value)}
                placeholder="Optional override"
              />
            </label>
            <label>
              <span>PDF file</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(event) => setAutoBuildFile(event.target.files?.[0] || null)}
                required
              />
            </label>
            <button type="submit" disabled={!hasGuard(user, 'canEditTemplate')}>
              Run auto-build
            </button>
          </form>
          <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
            {statusMessage || 'Auto-build stays intact, but now starts from a real templates screen.'}
          </p>
        </Card>
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
                  <Badge tone={template.publishState === 'published' ? 'success' : 'warning'}>
                    {template.publishState || 'draft'}
                  </Badge>
                </div>
                <p className="muted">File: {template.fileName}</p>
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
