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
  snapshot: LayoutField[]
}

// Undo/redo keeps a bounded stack of full layout snapshots.
const HISTORY_LIMIT = 50
// Layout coordinates are stored in PDF points (1/72"). A 6pt grid lands at
// roughly 8px on a 96dpi display: coarse enough to feel magnetic, fine enough
// for form alignment. Kept OFF by default so precise drags stay exact.
const SNAP_GRID_POINTS = 6
const SNAP_STORAGE_KEY = 'kinetic.mapper.snapToGrid'

function snapValue(value: number) {
  return Math.round(value / SNAP_GRID_POINTS) * SNAP_GRID_POINTS
}

function snapField(field: LayoutField, pageWidth = Infinity, pageHeight = Infinity): LayoutField {
  // Snapping can push a field past the lower AND upper page bounds; clamp both so
  // a snapped placement never lands off the page. Widths/heights are clamped to
  // the page extent, then x/y are clamped so the (snapped) box stays fully on-page.
  const maxWidth = Math.max(8, pageWidth)
  const maxHeight = Math.max(8, pageHeight)
  const width = clamp(Math.max(8, snapValue(Number(field.width || 1))), 8, maxWidth)
  const height = clamp(Math.max(8, snapValue(Number(field.height || 1))), 8, maxHeight)
  const x = clamp(Math.max(0, snapValue(Number(field.x || 0))), 0, Math.max(0, pageWidth - width))
  const y = clamp(Math.max(0, snapValue(Number(field.y || 0))), 0, Math.max(0, pageHeight - height))
  return { ...field, x, y, width, height }
}

function readSnapPreference() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SNAP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
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
  const savedLayoutRef = useRef('')
  const [fields, setFields] = useState<LayoutField[]>([])
  const [past, setPast] = useState<LayoutField[][]>([])
  const [future, setFuture] = useState<LayoutField[][]>([])
  const [snapEnabled, setSnapEnabled] = useState<boolean>(() => readSnapPreference())
  const fieldsRef = useRef<LayoutField[]>([])
  fieldsRef.current = fields
  const snapEnabledRef = useRef(snapEnabled)
  snapEnabledRef.current = snapEnabled
  const [statusMessage, setStatusMessage] = useState('')
  const [renderError, setRenderError] = useState('')
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [viewport, setViewport] = useState<ViewportState | null>(null)

  const { data, error, loading } = useAsync<DocumentTemplate[]>(() => api.get(routes.documentTemplates()), [templateId])
  const template = data?.find((entry) => entry.id === templateId) || null

  useEffect(() => {
    if (!template) return
    const nextFields = defaultLayout(template)
    setFields(nextFields)
    savedLayoutRef.current = JSON.stringify(nextFields)
    setPast([])
    setFuture([])
    setPageIndex(0)
  }, [template?.id, template?.updatedAt])

  useEffect(() => {
    try {
      window.localStorage.setItem(SNAP_STORAGE_KEY, snapEnabled ? '1' : '0')
    } catch {
      /* localStorage may be unavailable; the toggle still works in-session. */
    }
  }, [snapEnabled])

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

  // Live drag/resize updates deliberately bypass history: a single completed
  // gesture becomes one undo entry, committed at pointer-up.
  function updateField(index: number, patch: Partial<LayoutField>) {
    setFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)))
  }

  // Record the current layout onto the undo stack, then apply the next layout.
  function commit(next: LayoutField[]) {
    setPast((entries) => [...entries, fieldsRef.current].slice(-HISTORY_LIMIT))
    setFuture([])
    setFields(next)
  }

  function updateFieldCommitted(index: number, patch: Partial<LayoutField>) {
    commit(fieldsRef.current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)))
  }

  // Coordinate-table edits: typing a number must NOT push a history entry per
  // keystroke (that would blow past the 50-entry cap and evict real undo state).
  // Instead the pre-edit snapshot is captured once when a cell is focused / first
  // mutated, values apply LIVE to layout state, and a single history entry is
  // pushed on blur or Enter — one coherent undo per field edit.
  const cellEditSnapshotRef = useRef<LayoutField[] | null>(null)

  function beginCellEdit() {
    if (!cellEditSnapshotRef.current) cellEditSnapshotRef.current = fieldsRef.current
  }

  function updateFieldLive(index: number, patch: Partial<LayoutField>) {
    // Arm the snapshot on the first live change even if focus was missed.
    if (!cellEditSnapshotRef.current) cellEditSnapshotRef.current = fieldsRef.current
    updateField(index, patch)
  }

  function commitCellEdit() {
    const snapshot = cellEditSnapshotRef.current
    cellEditSnapshotRef.current = null
    if (!snapshot) return
    if (JSON.stringify(snapshot) === JSON.stringify(fieldsRef.current)) return
    setPast((entries) => [...entries, snapshot].slice(-HISTORY_LIMIT))
    setFuture([])
  }

  function duplicateField(index: number) {
    const source = fieldsRef.current[index]
    if (!source) return
    // Duplicate a placement (not a new form field): the layout array allows
    // multiple entries per fieldName and the save route/renderer round-trip it.
    const clone: LayoutField = {
      ...source,
      x: Math.max(0, Number(source.x || 0) + 12),
      y: Math.max(0, Number(source.y || 0) - 12)
    }
    commit([...fieldsRef.current.slice(0, index + 1), clone, ...fieldsRef.current.slice(index + 1)])
  }

  function deleteField(index: number) {
    commit(fieldsRef.current.filter((_, fieldIndex) => fieldIndex !== index))
  }

  function undo() {
    if (!past.length) return
    const previous = past[past.length - 1]
    setPast(past.slice(0, -1))
    setFuture([fieldsRef.current, ...future].slice(0, HISTORY_LIMIT))
    setFields(previous)
  }

  function redo() {
    if (!future.length) return
    const next = future[0]
    setFuture(future.slice(1))
    setPast([...past, fieldsRef.current].slice(-HISTORY_LIMIT))
    setFields(next)
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
      viewport,
      snapshot: fieldsRef.current
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
      const state = pointerRef.current
      pointerRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      if (!state) return
      const current = fieldsRef.current
      // Snap-to-grid quantizes only the settled field, folded into this same
      // gesture so it costs a single undo entry.
      const pageWidthPoints = state.viewport.width / state.viewport.scale
      const settled = snapEnabledRef.current
        ? current.map((field, fieldIndex) =>
            fieldIndex === state.index ? snapField(field, pageWidthPoints, state.viewport.pageHeight) : field
          )
        : current
      const changed = JSON.stringify(settled) !== JSON.stringify(state.snapshot)
      if (changed) {
        setPast((entries) => [...entries, state.snapshot].slice(-HISTORY_LIMIT))
        setFuture([])
      }
      if (settled !== current) setFields(settled)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }

  const undoRef = useRef(() => {})
  const redoRef = useRef(() => {})
  undoRef.current = undo
  redoRef.current = redo

  // Ctrl/Cmd+Z undo, Ctrl+Y or Ctrl/Cmd+Shift+Z redo — scoped to this page and
  // ignored while typing in a form control so field editing keeps native undo.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undoRef.current()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redoRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function handleSave() {
    if (!template) return
    setStatusMessage('')
    try {
      await api.patch(routes.documentTemplatePdfLayout(template.id), { fields })
      savedLayoutRef.current = JSON.stringify(fields)
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
  // A field name may be placed multiple times (duplicate placements). Testids must
  // stay unique for strict e2e selectors, so the FIRST placement of each name
  // keeps the exact existing testid (pdf-field-overlay-<name>) and each later
  // duplicate is suffixed (--2, --3, …). Ranked over the full fields array by
  // original index so the suffix is stable regardless of the current page.
  const placementSuffix = new Map<number, string>()
  const nameSeenCount = new Map<string, number>()
  fields.forEach((field, index) => {
    const name = String(field.fieldName)
    const seen = nameSeenCount.get(name) || 0
    nameSeenCount.set(name, seen + 1)
    placementSuffix.set(index, seen === 0 ? '' : `--${seen + 1}`)
  })
  const extractedFieldNames = (
    template.extraction?.fields?.length ? template.extraction.fields : template.extractedFields || []
  )
    .map((field) => fieldName(field))
    .filter(Boolean)
  const mappedPdfFields = new Set((template.mappings || []).map((mapping) => String(mapping.pdfField || '').trim()))
  const missingMappingFields = extractedFieldNames.filter((name) => !mappedPdfFields.has(name))
  const unsavedLayout = JSON.stringify(fields) !== savedLayoutRef.current

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
            <StatusBadge status={`${visibleFields.length} on page ${pageIndex + 1}`} />
            <StatusBadge status={missingMappingFields.length ? 'missing mappings' : 'mapping complete'} />
            <StatusBadge status={unsavedLayout ? 'unsaved layout changes' : 'layout saved'} />
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
              <div className="mapper-toolbar mapper-history-toolbar">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => undo()}
                  disabled={!past.length}
                  title="Undo (Ctrl+Z)"
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => redo()}
                  disabled={!future.length}
                  title="Redo (Ctrl+Y)"
                >
                  Redo
                </button>
                <label className="mapper-snap-toggle">
                  <input
                    type="checkbox"
                    checked={snapEnabled}
                    onChange={(event) => setSnapEnabled(event.target.checked)}
                  />
                  <span>Snap to grid</span>
                </label>
                <span className="muted mapper-history-hint">
                  {past.length ? `${past.length} undo step${past.length === 1 ? '' : 's'}` : 'No history yet'}
                </span>
              </div>
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
                {/* Overlays are only meaningful (and draggable) once the rendered viewport is known. */}
                {viewport &&
                  visibleFields.map(({ field, index }) => (
                  <div
                    key={`${field.fieldName}-${index}`}
                    data-testid={`pdf-field-overlay-${field.fieldName}${placementSuffix.get(index) || ''}`}
                    className={`pdf-field-overlay${field.locked ? ' pdf-field-overlay-locked' : ''}`}
                    style={overlayStyle(field, viewport)}
                    onPointerDown={(event) => handlePointerDown(index, 'drag', event)}
                  >
                    <span>{field.fieldName}</span>
                    {!field.locked ? (
                      <div
                        className="pdf-field-resize-handle"
                        data-testid={`pdf-field-resize-${field.fieldName}${placementSuffix.get(index) || ''}`}
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
              <p className="muted">
                Renderer mode:{' '}
                {template.sourceArtifact ? 'source-backed AcroForm fill' : 'fallback summary export only'}.
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
                  <th>Actions</th>
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
                        onFocus={beginCellEdit}
                        onChange={(event) => updateFieldLive(index, { pageIndex: Number(event.target.value) })}
                        onBlur={commitCellEdit}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitCellEdit()
                        }}
                      />
                    </td>
                    {(['x', 'y', 'width', 'height'] as const).map((key) => (
                      <td key={key}>
                        <input
                          aria-label={`${key} for ${field.fieldName}`}
                          type="number"
                          value={Number(field[key] || 0)}
                          onFocus={beginCellEdit}
                          onChange={(event) => updateFieldLive(index, { [key]: Number(event.target.value) })}
                          onBlur={commitCellEdit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitCellEdit()
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        aria-label={`Locked ${field.fieldName}`}
                        type="checkbox"
                        checked={field.locked === true}
                        onChange={(event) => updateFieldCommitted(index, { locked: event.target.checked })}
                      />
                    </td>
                    <td>
                      <div className="mapper-row-actions">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => duplicateField(index)}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => deleteField(index)}
                        >
                          Delete
                        </button>
                      </div>
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
