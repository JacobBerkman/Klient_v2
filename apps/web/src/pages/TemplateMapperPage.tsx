import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { api, routes } from '../lib/client'
import { useAsync } from '../lib/useAsync'
import type { DocumentTemplate } from '../lib/types'
import { Card, EmptyState, ErrorState, Field, LoadingState, PageHero, PageSection, StatusBadge } from '../components/ui'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export const handle = {
  title: ({ templateId }: Record<string, string | undefined>) => `Mapper ${templateId || ''}`.trim(),
  subtitle: 'Visual PDF field overlay editor for source-backed AcroForm templates.',
  breadcrumb: 'PDF mapper'
}

type LayoutField = NonNullable<NonNullable<DocumentTemplate['pdfLayout']>['fields']>[number]

function fieldName(field: Record<string, unknown> | string) {
  return String(typeof field === 'string' ? field : field.fieldName || field.name || '')
}

function defaultLayout(template: DocumentTemplate): LayoutField[] {
  const existing = template.pdfLayout?.fields || []
  if (existing.length) return existing
  const fields = template.extraction?.fields?.length ? template.extraction.fields : template.extractedFields || []
  return fields
    .map((field, index) => ({
      fieldName: fieldName(field),
      pageIndex: 0,
      x: 72,
      y: Math.max(72, 700 - index * 32),
      width: 180,
      height: 24,
      locked: false
    }))
    .filter((field) => field.fieldName)
}

export function Component() {
  const { templateId = '' } = useParams()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [fields, setFields] = useState<LayoutField[]>([])
  const [statusMessage, setStatusMessage] = useState('')
  const [renderError, setRenderError] = useState('')

  const { data, error, loading } = useAsync<DocumentTemplate[]>(() => api.get(routes.documentTemplates()), [templateId])
  const template = data?.find((entry) => entry.id === templateId) || null

  useEffect(() => {
    if (!template) return
    setFields(defaultLayout(template))
  }, [template?.id, template?.updatedAt])

  useEffect(() => {
    let cancelled = false
    async function renderPdf() {
      if (!template?.sourceArtifact || !canvasRef.current) return
      setRenderError('')
      try {
        const response = await fetch(routes.documentTemplateSourcePdf(template.id), { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`Source PDF request failed with ${response.status}`)
        const bytes = await response.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
        const page = await pdf.getPage(1)
        const viewport = page.getViewport({ scale: 1.15 })
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context || cancelled) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        await page.render({ canvas, canvasContext: context, viewport }).promise
      } catch (renderFailure) {
        if (!cancelled) {
          setRenderError(renderFailure instanceof Error ? renderFailure.message : 'Unable to render PDF preview.')
        }
      }
    }
    void renderPdf()
    return () => {
      cancelled = true
    }
  }, [template?.id, template?.sourceArtifact])

  function updateField(index: number, patch: Partial<LayoutField>) {
    setFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)))
  }

  async function handleSave() {
    if (!template) return
    setStatusMessage('')
    try {
      await api.patch(routes.documentTemplatePdfLayout(template.id), { fields })
      setStatusMessage('PDF layout saved.')
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'Unable to save PDF layout.')
    }
  }

  if (loading) return <LoadingState label="Loading PDF mapper" />
  if (error || !data) return <ErrorState title="PDF mapper failed to load." detail={error?.message} />
  if (!template)
    return <ErrorState title="Template not found." detail="Open an existing template before mapping fields." />

  return (
    <div className="stack">
      <PageHero
        eyebrow="PDF mapper"
        title={template.name}
        subtitle="Preview the uploaded PDF, inspect extracted fields, and maintain overlay coordinates without changing the export renderer."
        actions={
          <Link className="secondary-button" to={`/templates/${template.id}`}>
            Back to template
          </Link>
        }
        meta={
          <>
            <StatusBadge status={template.extraction?.status || 'unknown'} />
            <StatusBadge status={template.sourceArtifact ? 'source pdf available' : 'no source pdf'} />
            <StatusBadge status={`${fields.length} overlays`} />
          </>
        }
      />

      <PageSection
        title="Preview and overlays"
        subtitle="Coordinates are stored as template metadata for review and future placement workflows."
      >
        {template.sourceArtifact ? (
          <div className="mapper-grid">
            <Card className="mapper-preview-card">
              <div className="pdf-preview-shell">
                <canvas ref={canvasRef} className="pdf-preview-canvas" />
                {fields
                  .filter((field) => Number(field.pageIndex || 0) === 0)
                  .map((field, index) => (
                    <div
                      key={`${field.fieldName}-${index}`}
                      className="pdf-field-overlay"
                      style={{
                        left: `${Number(field.x || 0) * 1.15}px`,
                        top: `${Math.max(0, 792 - Number(field.y || 0) - Number(field.height || 0)) * 1.15}px`,
                        width: `${Number(field.width || 1) * 1.15}px`,
                        height: `${Number(field.height || 1) * 1.15}px`
                      }}
                    >
                      {field.fieldName}
                    </div>
                  ))}
              </div>
              {renderError ? <p className="inline-notice inline-notice-warning">{renderError}</p> : null}
            </Card>

            <Card className="section-card">
              <h3>Mapper scope</h3>
              <p className="muted">
                Filled AcroForm export remains canonical. This overlay editor stores field placement metadata for
                review, test-fill previews, and future non-AcroForm placement work.
              </p>
              <button type="button" onClick={() => void handleSave()}>
                Save PDF layout
              </button>
              <p className={statusMessage ? 'inline-notice inline-notice-info' : 'muted'}>
                {statusMessage || 'Saving creates a versioned and audited pdf_layout_updated event.'}
              </p>
            </Card>
          </div>
        ) : (
          <EmptyState
            title="No source PDF available."
            detail="Use Auto-build from PDF to create a source-backed template before opening the visual mapper."
          />
        )}
      </PageSection>

      <PageSection
        title="Field coordinates"
        subtitle="Adjust numeric placement data. Drag/resize can build on this saved metadata."
      >
        {fields.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Page</th>
                  <th>X</th>
                  <th>Y</th>
                  <th>Width</th>
                  <th>Height</th>
                  <th>Locked</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field, index) => (
                  <tr key={`${field.fieldName}-${index}`}>
                    <td>{field.fieldName}</td>
                    <td>
                      <Field label="Page">
                        <input
                          type="number"
                          min="0"
                          value={Number(field.pageIndex || 0)}
                          onChange={(event) => updateField(index, { pageIndex: Number(event.target.value) })}
                        />
                      </Field>
                    </td>
                    {(['x', 'y', 'width', 'height'] as const).map((key) => (
                      <td key={key}>
                        <input
                          type="number"
                          value={Number(field[key] || 0)}
                          onChange={(event) => updateField(index, { [key]: Number(event.target.value) })}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        type="checkbox"
                        checked={field.locked === true}
                        onChange={(event) => updateField(index, { locked: event.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No extracted fields." detail="The mapper needs a completed AcroForm extraction first." />
        )}
      </PageSection>
    </div>
  )
}
