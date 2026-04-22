function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function mappingKey(mapping) {
  return String(
    mapping?.pdfField || mapping?.targetField || mapping?.target || mapping?.field || mapping?.key || ''
  ).trim()
}

export function mergeMappingsByPdfField(existingMappings = [], overrides = []) {
  const byField = new Map()
  const orderedFields = []

  for (const mapping of Array.isArray(existingMappings) ? existingMappings : []) {
    const pdfField = mappingKey(mapping)
    if (!pdfField) continue
    if (!byField.has(pdfField)) orderedFields.push(pdfField)
    byField.set(pdfField, clone(mapping))
  }

  for (const override of Array.isArray(overrides) ? overrides : []) {
    const pdfField = mappingKey(override)
    if (!pdfField) continue
    if (!byField.has(pdfField)) orderedFields.push(pdfField)
    const base = byField.get(pdfField) || { pdfField }
    byField.set(pdfField, { ...base, ...clone(override), pdfField })
  }

  return orderedFields.map((pdfField) => byField.get(pdfField))
}

export function assertMappingsCoverPdfFields(mappings = [], extractedFields = []) {
  const mappedFields = new Set(
    (Array.isArray(mappings) ? mappings : []).map((mapping) => mappingKey(mapping)).filter(Boolean)
  )
  const missing = (Array.isArray(extractedFields) ? extractedFields : [])
    .map((field) => String(field?.fieldName || field || '').trim())
    .filter((fieldName) => fieldName && !mappedFields.has(fieldName))
  if (missing.length) {
    throw new Error(`Mappings do not cover required PDF fields: ${missing.join(', ')}`)
  }
}
