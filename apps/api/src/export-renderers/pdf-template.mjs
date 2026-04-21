import { PDFDocument } from 'pdf-lib'

function summarizeValue(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((entry) => summarizeValue(entry)).join('; ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function truthy(value) {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  return ['1', 'true', 'yes', 'y', 'on', 'checked'].includes(normalized)
}

function fillField(field, value) {
  if (value === null || value === undefined || value === '') return { filled: false, reason: 'empty_value' }
  if (typeof field?.setText === 'function') {
    field.setText(summarizeValue(value))
    return { filled: true, mode: 'text' }
  }
  if (typeof field?.check === 'function' && typeof field?.uncheck === 'function') {
    if (truthy(value)) field.check()
    else field.uncheck()
    return { filled: true, mode: 'checkbox' }
  }
  if (typeof field?.select === 'function') {
    field.select(summarizeValue(value))
    return { filled: true, mode: 'select' }
  }
  return { filled: false, reason: 'unsupported_field_type' }
}

export async function renderPdfFromTemplate({ sourcePdfBytes, resolvedRows = [], flatten = false } = {}) {
  const diagnostics = []
  const pdf = await PDFDocument.load(Buffer.from(sourcePdfBytes), { ignoreEncryption: true, updateMetadata: false })
  const form = pdf.getForm()
  const byField = new Map()
  form.getFields().forEach((field) => byField.set(field.getName(), field))

  for (const row of resolvedRows) {
    const pdfField = String(row?.pdfField || '').trim()
    if (!pdfField) continue
    const field = byField.get(pdfField)
    if (!field) {
      diagnostics.push({
        type: 'export_render',
        severity: row.required ? 'error' : 'warning',
        code: 'PDF_FIELD_NOT_FOUND',
        message: `PDF field "${pdfField}" was not found in the source template.`,
        details: { pdfField, sourcePath: row.sourcePath || null }
      })
      continue
    }
    try {
      const result = fillField(field, row.value)
      if (!result.filled) {
        diagnostics.push({
          type: 'export_render',
          severity: result.reason === 'unsupported_field_type' ? 'warning' : 'info',
          code: result.reason === 'unsupported_field_type' ? 'PDF_FIELD_UNSUPPORTED' : 'PDF_FIELD_SKIPPED_EMPTY',
          message:
            result.reason === 'unsupported_field_type'
              ? `PDF field "${pdfField}" has a type that cannot be filled automatically.`
              : `PDF field "${pdfField}" had no resolved value.`,
          details: { pdfField, sourcePath: row.sourcePath || null }
        })
      }
    } catch (error) {
      diagnostics.push({
        type: 'export_render',
        severity: 'warning',
        code: 'PDF_FIELD_FILL_FAILED',
        message: `PDF field "${pdfField}" could not be filled.`,
        details: { pdfField, sourcePath: row.sourcePath || null, error: String(error?.message || error) }
      })
    }
  }

  if (flatten) {
    try {
      form.flatten()
    } catch (error) {
      diagnostics.push({
        type: 'export_render',
        severity: 'warning',
        code: 'PDF_FLATTEN_FAILED',
        message: 'PDF fields were filled, but flattening failed.',
        details: { error: String(error?.message || error) }
      })
    }
  }

  let body
  try {
    body = Buffer.from(await pdf.save({ updateFieldAppearances: true }))
  } catch (error) {
    diagnostics.push({
      type: 'export_render',
      severity: 'warning',
      code: 'PDF_APPEARANCE_UPDATE_FAILED',
      message:
        'PDF values were filled, but appearance regeneration failed; saved the filled form without regenerating appearances.',
      details: { error: String(error?.message || error) }
    })
    body = Buffer.from(await pdf.save({ updateFieldAppearances: false }))
  }
  return { body, diagnostics }
}
