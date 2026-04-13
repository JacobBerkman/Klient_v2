const PDF_HEADER = '%PDF-'

const EXTRACTION_REASON = {
  malformed: 'malformed_pdf',
  noAcroForm: 'no_acroform',
  noFields: 'no_fields'
}

const INGESTION_ERRORS = {
  [EXTRACTION_REASON.malformed]: {
    code: 'TEMPLATE_INGESTION_MALFORMED_PDF',
    message: 'Unable to parse PDF bytes. Upload a valid AcroForm PDF.'
  },
  [EXTRACTION_REASON.noAcroForm]: {
    code: 'TEMPLATE_INGESTION_NO_ACROFORM',
    message: 'Uploaded PDF does not include an AcroForm definition.'
  },
  [EXTRACTION_REASON.noFields]: {
    code: 'TEMPLATE_INGESTION_NO_FIELDS',
    message: 'No fillable AcroForm fields were detected in the uploaded PDF.'
  }
}

function buildIngestionError(reasonCode) {
  if (!reasonCode) return null
  const normalized = INGESTION_ERRORS[reasonCode] || {
    code: 'TEMPLATE_INGESTION_FAILED',
    message: 'Template ingestion failed.'
  }
  return {
    reasonCode,
    code: normalized.code,
    message: normalized.message
  }
}

function buildIngestionDiagnostics(reasonCode, details = {}) {
  if (!reasonCode) return []
  const error = buildIngestionError(reasonCode)
  return [
    {
      type: 'ingestion',
      severity: 'error',
      reasonCode,
      code: error?.code || 'TEMPLATE_INGESTION_FAILED',
      message: error?.message || 'Template ingestion failed.',
      details: details && typeof details === 'object' ? details : {}
    }
  ]
}

function parsePdfStringLiteral(value) {
  if (!value) return ''
  return value.replace(/\\([\\()])/g, '$1')
}

function parseObjectMap(pdfText) {
  const map = new Map()
  const regex = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g
  let match = regex.exec(pdfText)
  while (match) {
    map.set(Number(match[1]), match[3].trim())
    match = regex.exec(pdfText)
  }
  return map
}

function parseRefList(value) {
  const refs = []
  if (!value) return refs
  const regex = /(\d+)\s+\d+\s+R/g
  let match = regex.exec(value)
  while (match) {
    refs.push(Number(match[1]))
    match = regex.exec(value)
  }
  return refs
}

function extractDictionary(raw) {
  if (!raw) return null
  const start = raw.indexOf('<<')
  const end = raw.lastIndexOf('>>')
  if (start < 0 || end < 0 || end <= start) return null
  return raw.slice(start + 2, end)
}

function parsePages(pdfObjects) {
  const pageOrder = []
  for (const [id, raw] of pdfObjects.entries()) {
    if (/\/Type\s*\/Page\b/.test(raw)) pageOrder.push(id)
  }
  const index = new Map()
  pageOrder.forEach((id, pageIndex) => index.set(id, pageIndex))
  return index
}

function parseFieldType(dict, flags, inheritedType = null) {
  const type = /\/FT\s*\/(\w+)/.exec(dict)?.[1] || inheritedType || null
  if (type === 'Tx') return 'text'
  if (type === 'Ch') return 'choice'
  if (type === 'Sig') return 'signature'
  if (type === 'Btn') {
    if ((flags & 32768) !== 0) return 'radio'
    return 'checkbox'
  }
  return type ? type.toLowerCase() : 'unknown'
}

function parseFieldDictionary(dict, parent = {}) {
  const name = /\/T\s*\(([^)]*)\)/.exec(dict)?.[1]
  const ft = /\/FT\s*\/(\w+)/.exec(dict)?.[1]
  const flagsMatch = /\/Ff\s+(\d+)/.exec(dict)
  const flags = flagsMatch ? Number(flagsMatch[1]) : parent.flags || 0
  const kidsRaw = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1] || null
  const pageRefMatch = /\/P\s*(\d+)\s+\d+\s+R/.exec(dict)
  return {
    name: parsePdfStringLiteral(name || parent.name || ''),
    flags,
    ft: ft || parent.ft || null,
    kids: parseRefList(kidsRaw),
    pageRef: pageRefMatch ? Number(pageRefMatch[1]) : parent.pageRef || null
  }
}

function resolveAcroFormObject(pdfText, pdfObjects) {
  const direct = /\/AcroForm\s*<<(.*?)>>/s.exec(pdfText)
  if (direct) return `<<${direct[1]}>>`
  const refMatch = /\/AcroForm\s*(\d+)\s+\d+\s+R/.exec(pdfText)
  if (!refMatch) return null
  return pdfObjects.get(Number(refMatch[1])) || null
}

export function extractTemplateFieldsFromPdfBytes(bytes) {
  if (!bytes || bytes.length === 0) {
    const reasonCode = EXTRACTION_REASON.malformed
    return {
      status: 'failed',
      reasonCode,
      error: buildIngestionError(reasonCode),
      diagnostics: buildIngestionDiagnostics(reasonCode, { stage: 'header', bytesLength: 0 }),
      fields: []
    }
  }
  const pdfText = Buffer.from(bytes).toString('latin1')
  if (!pdfText.startsWith(PDF_HEADER)) {
    const reasonCode = EXTRACTION_REASON.malformed
    return {
      status: 'failed',
      reasonCode,
      error: buildIngestionError(reasonCode),
      diagnostics: buildIngestionDiagnostics(reasonCode, { stage: 'header', bytesLength: bytes.length }),
      fields: []
    }
  }

  const pdfObjects = parseObjectMap(pdfText)
  const acroFormRaw = resolveAcroFormObject(pdfText, pdfObjects)
  if (!acroFormRaw) {
    const reasonCode = EXTRACTION_REASON.noAcroForm
    return {
      status: 'failed',
      reasonCode,
      error: buildIngestionError(reasonCode),
      diagnostics: buildIngestionDiagnostics(reasonCode, { stage: 'acroform' }),
      fields: []
    }
  }

  const acroFormDict = extractDictionary(acroFormRaw) || acroFormRaw
  const fieldsRaw = /\/Fields\s*\[([^\]]*)\]/.exec(acroFormDict)?.[1] || null
  const rootRefs = parseRefList(fieldsRaw)
  if (!rootRefs.length) {
    const reasonCode = EXTRACTION_REASON.noFields
    return {
      status: 'failed',
      reasonCode,
      error: buildIngestionError(reasonCode),
      diagnostics: buildIngestionDiagnostics(reasonCode, { stage: 'fields', rootRefs: 0 }),
      fields: []
    }
  }

  const pageIndexByRef = parsePages(pdfObjects)
  const extracted = []
  const stack = rootRefs.map((id) => ({ id, parent: {} }))

  while (stack.length) {
    const current = stack.pop()
    const raw = pdfObjects.get(current.id)
    if (!raw) continue
    const dict = extractDictionary(raw)
    if (!dict) continue
    const field = parseFieldDictionary(dict, current.parent)

    if (field.kids.length) {
      for (const kidRef of field.kids) {
        stack.push({ id: kidRef, parent: field })
      }
      if (!/\/Subtype\s*\/Widget\b/.test(dict)) continue
    }

    if (!field.name) continue
    extracted.push({
      fieldName: field.name,
      fieldType: parseFieldType(dict, field.flags, field.ft),
      pageIndex: field.pageRef != null ? pageIndexByRef.get(field.pageRef) ?? null : null,
      required: (field.flags & 2) !== 0,
      readOnly: (field.flags & 1) !== 0
    })
  }

  if (!extracted.length) {
    const reasonCode = EXTRACTION_REASON.noFields
    return {
      status: 'failed',
      reasonCode,
      error: buildIngestionError(reasonCode),
      diagnostics: buildIngestionDiagnostics(reasonCode, { stage: 'fields', rootRefs: rootRefs.length }),
      fields: []
    }
  }

  return { status: 'completed', reasonCode: null, error: null, diagnostics: [], fields: extracted }
}
