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

interface ViewportState {
  scale: number
  width: number
  height: number
  pageHeight: number
}

interface PointerState {
  mode: 'drag' | 'resize'
  index: number
  startClientX: number
  startClientY: number
  startField: LayoutField
  viewport: ViewportState
}

function fieldName(field: Record<string, unknown> | string) {
  return String(typeof field === 'string' ? field : field.fieldName || field.name || '')
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function defaultLayout(template: DocumentTemplate): LayoutField[] {
  const existing = template.pdfLayout?.fields || []
  if (existing.length) return existing
  const fields = template.extraction?.fields?.length ? template.extraction.fields : template.extractedFields || []
  return fields
    .map((field, index) => ({
      fieldName: fieldName(field),
      pageIndex: Number((field as Record<string, unknown>)?.pageIndex || 0),
      x: 72,
      y: Math.max(72, 700 - index * 32),
      width: 180,
      height: 24,
      locked: false
    }))
    .filter((field) => field.fieldName)
}

function overlayStyle(field: LayoutField, viewport: ViewportState | null) {
  if (!viewport) return {}
  const x = Number(field.x || 0)
  const y = Number(field.y || 0)
  const width = Number(field.width || 1)
  const height = Number(field.height || 1)
  return {
    left: `${x * viewport.scale}px`,
    top: `${Math.max(0, viewport.pageHeight - y - height) * viewport.scale}px`,
    width: `${width * viewport.scale}px`,
    height: `${height * viewport.scale}px`
  }
}

export function Component() {
  const { templateId = '' } = useParams()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pointerRef = useRef<PointerState | null>(null)
  const [fields, setFields] = useState<LayoutField[]>([])
  const [statusMessage, setStatusMessage] = useState('')
  const [renderError, setRenderError] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [viewport, setViewport] = useState<ViewportState | null>(null)

  const { data, error, loading } = useAsync<DocumentTemplate[]>(() => api.get(routes.documentTemplates()), [templateId])
  const template = data?.find((entry) => entry.id === templateId) || null

  useEffect(() => {
    if (!template) return
    setFields(defaultLayout(template))
    setPageIndex(0)
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
        const nextPageCount = Math.max(1, pdf.numPages || 1)
        const safePageIndex = clamp(pageIndex, 0, nextPageCount - 1)
        const page = await pdf.getPage(safePageIndex + 1)
        const nextViewport = page.getViewport({ scale: 1.15 })
        const canvas = canvasRef.current
        const context = canvas.getContext('2d')
        if (!context || cancelled) return
        canvas.width = Math.floor(nextViewport.width)
        canvas.height = Math.floor(nextViewport.height)
        await page.render({ canvas, canvasContext: context, viewport: nextViewport }).promise
        if (cancelled) return
        setPageCount(nextPageCount)
        setPageIndex(safePageIndex)
        setViewport({
          scale: nextViewport.scale,
          width: nextViewport.width,
          height: nextViewport.height,
          pageHeight: nextViewport.height / nextViewport.scale
        })
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
  }, [template?.id, template?.sourceArtifact, pageIndex])

  function updateField(index: number, patch: Partial<LayoutField>) {
    setFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)))
  }

  function handlePointerDown(index: number, mode: PointerState['mode'], event: React.PointerEvent<HTMLDivElement>) {
    if (!viewport || fields[index]?.locked) return
    event.preventDefault()
    const startField = { ...fields[index] }
    pointerRef.current = {
      mode,
      index,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startField,
      viewport
    }
    const handleMove = (moveEvent: PointerEvent) => {
      const state = pointerRef.current
      if (!state) return
      const dx = (moveEvent.clientX - state.startClientX) / state.viewport.scale
      const dy = (moveEvent.clientY - state.startClientY) / state.viewport.scale
      const startX = Number(state.startField.x || 0)
      const startY = Number(state.startField.y || 0)
      const startWidth = Number(state.startField.width || 1)
      const startHeight = Number(state.startField.height || 1)
      if (state.mode === 'drag') {
        updateField(state.index, {
          x: clamp(startX + dx, 0, state.viewport.width / state.viewport.scale - startWidth),
          y: clamp(startY - dy, 0, state.viewport.pageHeight - startHeight)
        })
      } else {
        const width = clamp(startWidth + dx, 8, state.viewport.width / state.viewport.scale - startX)
        const height = clamp(startHeight + dy, 8, state.viewport.pageHeight)
        updateField(state.index, {
          width,
          height,
          y: clamp(startY - dy, 0, state.viewport.pageHeight - height)
        })
      }
    }
    const handleUp = () => {
      pointerRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
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

  async function handleTestFillPreview() {
    if (!template) return
    setStatusMessage('')
    try {
      const values = Object.fromEntries(fields.map((field, index) => [String(field.fieldName), `Preview ${index + 1}`]))
      const { blob } = await api.postBlob(routes.documentTemplateTestFillPreview(template.id), { values })
      const previewUrl = URL.createObjectURL(blob)
      window.open(previewUrl, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000)
      setStatusMessage('Test-fill preview generated.')
    } catch (previewError) {
      setStatusMessage(previewError instanceof Error ? previewError.message : 'Unable to generate test-fill preview.')
    }
  }

  if (loading) return <LoadingState label="Loading PDF mapper" />
  if (error || !data) return <ErrorState title="PDF mapper failed to load." detail={error?.message} />
  if (!template)
    return <ErrorState title="Template not found." detail="Open an existing template before mapping fields." />

  const visibleFields = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => Number(field.pageIndex || 0) === pageIndex)
  const extractedFieldNames = (
    template.extraction?.fields?.length ? template.extraction.fields : template.extractedFields || []
  )
    .map((field) => fieldName(field))
    .filter(Boolean)
  const mappedPdfFields = new Set((template.mappings || []).map((mapping) => String(mapping.pdfField || '').trim()))
  const missingMappingFields = extractedFieldNames.filter((name) => !mappedPdfFields.has(name))

  return (
    <div className="stack">
      <PageHero
        eyebrow="PDF mapper"
        title={template.name}
        subtitle="Preview the uploaded PDF, drag or resize field overlays, and generate a temporary test-fill PDF without creating an export job."
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
            <StatusBadge status={missingMappingFields.length ? 'missing mappings' : 'mapping complete'} />
          </>
        }
      />

      <PageSection
        title="Preview and overlays"
        subtitle="Coordinates are stored in PDF points with page index zero-based."
      >
        {template.sourceArtifact ? (
          <div className="mapper-grid">
            <Card className="mapper-preview-card">
              <div className="mapper-toolbar">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
                  disabled={pageIndex === 0}
                >
                  Previous page
                </button>
                <Field label="Page">
                  <select value={pageIndex} onChange={(event) => setPageIndex(Number(event.target.value))}>
                    {Array.from({ length: pageCount }, (_, index) => (
                      <option key={index} value={index}>
                        Page {index + 1}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPageIndex((value) => Math.min(pageCount - 1, value + 1))}
                  disabled={pageIndex >= pageCount - 1}
                >
                  Next page
                </button>
              </div>
              <div className="pdf-preview-shell">
                <canvas ref={canvasRef} className="pdf-preview-canvas" />
                {visibleFields.map(({ field, index }) => (
                  <div
                    key={`${field.fieldName}-${index}`}
                    data-testid={`pdf-field-overlay-${field.fieldName}`}
                    className={`pdf-field-overlay${field.locked ? ' pdf-field-overlay-locked' : ''}`}
                    style={overlayStyle(field, viewport)}
                    onPointerDown={(event) => handlePointerDown(index, 'drag', event)}
                  >
                    <span>{field.fieldName}</span>
                    {!field.locked ? (
                      <div
                        className="pdf-field-resize-handle"
                        data-testid={`pdf-field-resize-${field.fieldName}`}
                        role="presentation"
                        onPointerDown={(event) => handlePointerDown(index, 'resize', event)}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
              {renderError ? <p className="inline-notice inline-notice-warning">{renderError}</p> : null}
            </Card>

            <Card className="section-card">
              <h3>Mapper actions</h3>
              <p className="muted">
                Filled AcroForm export remains canonical. Layout metadata supports review, overlay adjustments, and
                test-fill validation.
              </p>
              {missingMappingFields.length ? (
                <p className="inline-notice inline-notice-warning">
                  Mapping readiness is blocked by missing fields: {missingMappingFields.slice(0, 5).join(', ')}
                  {missingMappingFields.length > 5 ? `, and ${missingMappingFields.length - 5} more` : ''}.
                </p>
              ) : (
                <p className="inline-notice inline-notice-success">
                  Mapping readiness is complete for every extracted PDF field.
                </p>
              )}
              <div className="actions-row">
                <button type="button" onClick={() => void handleSave()}>
                  Save PDF layout
                </button>
                <button type="button" className="secondary-button" onClick={() => void handleTestFillPreview()}>
                  Generate test-fill preview
                </button>
              </div>
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

      <PageSection title="Field coordinates" subtitle="Use direct inputs for precise placement and accessibility.">
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
                      <input
                        aria-label={`Page for ${field.fieldName}`}
                        type="number"
                        min="0"
                        value={Number(field.pageIndex || 0)}
                        onChange={(event) => updateField(index, { pageIndex: Number(event.target.value) })}
                      />
                    </td>
                    {(['x', 'y', 'width', 'height'] as const).map((key) => (
                      <td key={key}>
                        <input
                          aria-label={`${key} for ${field.fieldName}`}
                          type="number"
                          value={Number(field[key] || 0)}
                          onChange={(event) => updateField(index, { [key]: Number(event.target.value) })}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        aria-label={`Locked ${field.fieldName}`}
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
