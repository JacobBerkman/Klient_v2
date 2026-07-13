import { suggestMapping } from './auto-map.mjs'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeKey(value, fallback = 'field') {
  const normalized = String(value || fallback)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return normalized || fallback
}

function titleize(value, fallback = 'Field') {
  const words = String(value || fallback)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_./[\]-]+/g, ' ')
    .trim()
  return words.replace(/\b\w/g, (token) => token.toUpperCase()) || fallback
}

function formFieldType(fieldType) {
  const normalized = String(fieldType || '').toLowerCase()
  if (normalized === 'checkbox') return 'checkbox'
  if (normalized === 'choice' || normalized === 'radio') return 'select'
  return 'text'
}

function mappingTargetType(fieldType) {
  return formFieldType(fieldType)
}

function dedupeFieldsByName(fields = []) {
  const output = []
  const seen = new Set()
  for (const field of fields) {
    const name = String(field?.fieldName || '').trim()
    const key = name.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(field)
  }
  return output
}

function candidateRepeater(fieldName) {
  const raw = String(fieldName || '').trim()
  const patterns = [
    /^(?<group>[a-zA-Z][\w-]*)\[(?<index>\d+)\][._-]?(?<leaf>.+)$/,
    /^(?<group>[a-zA-Z][\w-]*)\.(?<index>\d+)\.(?<leaf>.+)$/,
    /^(?<group>[a-zA-Z][\w-]*)_(?<index>\d+)_(?<leaf>.+)$/,
    /^(?<group>[a-zA-Z][a-zA-Z_]*?)(?<index>\d+)_(?<leaf>.+)$/
  ]
  for (const pattern of patterns) {
    const match = raw.match(pattern)
    if (!match?.groups) continue
    const group = normalizeKey(match.groups.group, 'items')
    const leaf = normalizeKey(match.groups.leaf, 'value')
    const parsedIndex = Number(match.groups.index)
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0) continue
    const oneBased = raw.includes(`_${parsedIndex}_`) || new RegExp(`${parsedIndex}_`).test(raw)
    return {
      group,
      leaf,
      rowIndex: oneBased && parsedIndex > 0 ? parsedIndex - 1 : parsedIndex
    }
  }
  return null
}

function buildDiagnostic(code, message, details = {}) {
  return {
    type: 'auto_build',
    severity: code.includes('AMBIGUOUS') ? 'warning' : 'info',
    code,
    message,
    details
  }
}

function buildFlatSection(fields) {
  const sectionByKey = new Map()
  for (const field of fields) {
    const parts = String(field.fieldName || '')
      .split(/[._/-]+/)
      .filter(Boolean)
    const sectionKey = parts.length > 1 ? normalizeKey(parts[0], 'generated') : 'generated'
    if (!sectionByKey.has(sectionKey)) {
      sectionByKey.set(sectionKey, {
        key: sectionKey,
        title: sectionKey === 'generated' ? 'Generated Fields' : titleize(sectionKey, 'Generated Fields'),
        fields: []
      })
    }
    const key = normalizeKey(field.fieldName, `field_${sectionByKey.get(sectionKey).fields.length + 1}`)
    sectionByKey.get(sectionKey).fields.push({
      key,
      label: titleize(field.fieldName, key),
      type: formFieldType(field.fieldType),
      required: field.required === true,
      readOnly: field.readOnly === true,
      metadata: {
        pdfField: field.fieldName,
        pdfFieldType: field.fieldType,
        pageIndex: field.pageIndex ?? null
      }
    })
  }
  return [...sectionByKey.values()]
}

function buildMappingsForFlatFields(fields) {
  return fields.map((field) => {
    const key = normalizeKey(field.fieldName, 'field')
    // Auto-build generates BOTH a filled PDF mapping and the intake form the
    // client answers, so the two must not fight. The generated form key stays
    // the primary source — a client's own answer always wins — and a confident
    // profile/spouse/household match rides along as fallbackSourcePath, which
    // export resolution uses only when the client left the field blank. Mapping
    // straight to profile.* here would silently discard what the client typed
    // into the very form this PDF produced.
    const suggestion = formFieldType(field.fieldType) === 'text' ? suggestMapping(field.fieldName) : null
    return {
      pdfField: field.fieldName,
      fieldLabel: titleize(field.fieldName, key),
      sourcePath: key,
      ...(suggestion ? { fallbackSourcePath: suggestion.sourcePath } : {}),
      targetType: mappingTargetType(field.fieldType),
      required: field.required === true,
      transform: field.fieldType === 'checkbox' ? { type: 'checkbox' } : null
    }
  })
}

export function buildFormTemplateFromExtractedFields(fields = []) {
  const normalizedFields = (Array.isArray(fields) ? fields : []).filter(isObject)
  const diagnostics = []
  const repeaterCandidates = []
  const flatFields = []

  for (const field of normalizedFields) {
    const candidate = candidateRepeater(field.fieldName)
    if (candidate) repeaterCandidates.push({ field, ...candidate })
    else flatFields.push(field)
  }

  const grouped = new Map()
  for (const candidate of repeaterCandidates) {
    if (!grouped.has(candidate.group)) grouped.set(candidate.group, [])
    grouped.get(candidate.group).push(candidate)
  }

  const repeatableSections = []
  const repeatableMappings = []
  for (const [group, candidates] of grouped.entries()) {
    const indices = new Set(candidates.map((candidate) => candidate.rowIndex))
    const leaves = new Set(candidates.map((candidate) => candidate.leaf))
    if (indices.size < 2 || leaves.size < 1) {
      diagnostics.push(
        buildDiagnostic(
          'TEMPLATE_AUTOBUILD_AMBIGUOUS_REPEATER',
          `Field group "${group}" looked indexed but did not have enough rows to create a repeatable section.`,
          { group, fieldNames: candidates.map((candidate) => candidate.field.fieldName) }
        )
      )
      flatFields.push(...candidates.map((candidate) => candidate.field))
      continue
    }

    repeatableSections.push({
      key: group,
      title: titleize(group, 'Repeatable Items'),
      repeatable: true,
      fields: [...leaves].map((leaf) => {
        const source = candidates.find((candidate) => candidate.leaf === leaf)?.field || {}
        return {
          key: leaf,
          label: titleize(leaf, leaf),
          type: formFieldType(source.fieldType),
          required: candidates.some((candidate) => candidate.leaf === leaf && candidate.field.required === true),
          metadata: {
            pdfFieldType: source.fieldType || 'unknown'
          }
        }
      })
    })

    for (const candidate of candidates) {
      repeatableMappings.push({
        pdfField: candidate.field.fieldName,
        fieldLabel: titleize(candidate.field.fieldName, candidate.leaf),
        sourcePath: `${group}.${candidate.rowIndex}.${candidate.leaf}`,
        repeaterPath: group,
        targetType: mappingTargetType(candidate.field.fieldType),
        required: candidate.field.required === true,
        transform: candidate.field.fieldType === 'checkbox' ? { type: 'checkbox' } : null
      })
    }
  }

  const uniqueFlatFields = dedupeFieldsByName(flatFields)
  const flatSections = buildFlatSection(uniqueFlatFields)
  const flatMappings = buildMappingsForFlatFields(uniqueFlatFields)
  const sections = [...flatSections, ...repeatableSections].filter((section) => section.fields.length)
  const mappings = [...flatMappings, ...repeatableMappings]
  const repeatableSectionCount = repeatableSections.length

  return {
    formSchema: { sections },
    mappings,
    diagnostics,
    summary: {
      fieldCount: normalizedFields.length,
      mappingCount: mappings.length,
      sectionCount: sections.length,
      repeatableSectionCount,
      ambiguousRepeaterCount: diagnostics.filter((entry) => entry.code === 'TEMPLATE_AUTOBUILD_AMBIGUOUS_REPEATER')
        .length
    }
  }
}
