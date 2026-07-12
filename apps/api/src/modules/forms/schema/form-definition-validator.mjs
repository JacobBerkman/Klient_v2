function validationError(message, issues) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'SCHEMA_VALIDATION_FAILED'
  error.details = { issues }
  return error
}

function pushIssue(issues, path, message) {
  issues.push({ path, message })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSegment(value, fallback = 'field') {
  const base = String(value || fallback).trim()
  return base.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || fallback
}

function normalizeRepeatableSection(section = {}) {
  if (!isObject(section)) return false
  if (section.repeatable === true) return true
  if (section.repeater === true) return true
  return String(section.type || '').trim().toLowerCase() === 'repeater'
}

function normalizeLegacySections(input) {
  if (Array.isArray(input)) {
    return {
      sections: input.map((entry, index) => {
        if (typeof entry === 'string') {
          return {
            key: normalizeSegment(entry, `section_${index + 1}`),
            title: entry,
            fields: []
          }
        }
        return entry
      })
    }
  }
  if (isObject(input) && Array.isArray(input.pages) && !Array.isArray(input.sections)) {
    return {
      sections: input.pages.map((page, index) => {
        if (typeof page === 'string') {
          return {
            key: normalizeSegment(page, `section_${index + 1}`),
            title: page,
            fields: []
          }
        }
        return page
      })
    }
  }
  return input
}

function collectRepeaterPaths(fields, parentPath, issues, basePath, target) {
  if (!Array.isArray(fields)) return
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const fieldPath = `${basePath}/${index}`
    if (!isObject(field)) {
      pushIssue(issues, fieldPath, 'Field must be an object.')
      continue
    }
    const id = field.path || field.key || field.name || field.id
    if (!id || typeof id !== 'string') {
      pushIssue(issues, `${fieldPath}/path`, 'Field requires path/key/name/id string.')
      continue
    }
    const normalizedId = normalizeSegment(id, `field_${index + 1}`)
    const fullPath = parentPath ? `${parentPath}.${normalizedId}` : normalizedId

    if (field.type === 'repeater') {
      target.add(fullPath)
    }

    if (Array.isArray(field.fields)) {
      collectRepeaterPaths(field.fields, fullPath, issues, `${fieldPath}/fields`, target)
    }
    if (Array.isArray(field.items)) {
      collectRepeaterPaths(field.items, fullPath, issues, `${fieldPath}/items`, target)
    }
  }
}

const VISIBLE_IF_OPS = new Set(['equals', 'notEquals', 'in', 'notEmpty'])

// The identifier a field is keyed by in submission data / referenced by a
// sibling's visibleIf. Mirrors fieldKey() in form-conditions.mjs.
function conditionFieldKey(field) {
  if (!isObject(field)) return ''
  return String(field.key ?? field.path ?? field.name ?? field.id ?? '')
}

// Validate the optional visibleIf conditions inside a single fields[] scope
// (one section, or one repeatable-section row). A condition may only reference
// a SIBLING field key in the same scope — cross-section references are rejected
// here because such a key is simply absent from this scope's key set. Self- and
// circular references are rejected too. Nested repeater sub-fields are validated
// recursively in their own scope.
function validateVisibleIfScope(fields, issues, basePath) {
  if (!Array.isArray(fields)) return

  const keySet = new Set()
  for (const field of fields) {
    if (!isObject(field)) continue
    const key = conditionFieldKey(field)
    if (key) keySet.add(key)
  }

  // field key -> referenced sibling key, for cycle detection.
  const edges = new Map()

  fields.forEach((field, index) => {
    if (!isObject(field)) return
    const fieldPath = `${basePath}/${index}`
    const key = conditionFieldKey(field)

    if (field.visibleIf !== undefined && field.visibleIf !== null) {
      const condition = field.visibleIf
      const conditionPath = `${fieldPath}/visibleIf`
      if (!isObject(condition)) {
        pushIssue(issues, conditionPath, 'visibleIf must be an object with { field, op, value? }.')
      } else {
        const ref = typeof condition.field === 'string' ? condition.field.trim() : ''
        if (!ref) {
          pushIssue(issues, `${conditionPath}/field`, 'visibleIf.field is required and must name a sibling field key.')
        } else if (ref === key) {
          pushIssue(issues, `${conditionPath}/field`, `visibleIf.field "${ref}" cannot reference the field itself.`)
        } else if (!keySet.has(ref)) {
          pushIssue(
            issues,
            `${conditionPath}/field`,
            `visibleIf.field "${ref}" must reference an existing field key in the same section (cross-section references are not allowed).`
          )
        } else {
          edges.set(key, ref)
        }

        if (!VISIBLE_IF_OPS.has(condition.op)) {
          pushIssue(
            issues,
            `${conditionPath}/op`,
            `visibleIf.op "${condition.op}" is not supported. Use one of: ${[...VISIBLE_IF_OPS].join(', ')}.`
          )
        } else if (condition.op === 'in') {
          if (!Array.isArray(condition.value) || condition.value.length === 0) {
            pushIssue(
              issues,
              `${conditionPath}/value`,
              'visibleIf.value must be a non-empty array of strings when op is "in".'
            )
          }
        } else if (condition.op !== 'notEmpty') {
          if (
            condition.value === undefined ||
            condition.value === null ||
            (typeof condition.value !== 'string' && typeof condition.value !== 'number')
          ) {
            pushIssue(
              issues,
              `${conditionPath}/value`,
              `visibleIf.value is required and must be a string when op is "${condition.op}".`
            )
          }
        }
      }
    }

    // Recurse into nested repeater sub-fields; each nested fields[] is its own
    // sibling scope.
    if (Array.isArray(field.fields)) {
      validateVisibleIfScope(field.fields, issues, `${fieldPath}/fields`)
    }
    if (Array.isArray(field.items)) {
      validateVisibleIfScope(field.items, issues, `${fieldPath}/items`)
    }
  })

  // Detect circular visibleIf references within this scope. Each node has at
  // most one outgoing edge, so a cycle is any node whose follow-the-edge walk
  // returns to a node already seen on this walk.
  for (const start of edges.keys()) {
    const seen = new Set()
    let current = start
    while (current !== undefined && edges.has(current)) {
      if (seen.has(current)) {
        pushIssue(
          issues,
          `${basePath}`,
          `Circular visibleIf reference detected involving field "${current}". Conditions must not form a cycle within a section.`
        )
        break
      }
      seen.add(current)
      current = edges.get(current)
    }
  }
}

export function convertLegacyFormDefinition(input) {
  const normalized = normalizeLegacySections(input)
  if (isObject(normalized) && Array.isArray(normalized.sections)) {
    return normalized
  }
  return { sections: [] }
}

export function validateFormDefinitionSchema(input, options = {}) {
  const contextPath = options.contextPath || '/formSchema'
  const schema = convertLegacyFormDefinition(input)
  const issues = []

  if (!isObject(schema)) {
    pushIssue(issues, contextPath, 'Form definition must be an object.')
  }
  if (!Array.isArray(schema.sections)) {
    pushIssue(issues, `${contextPath}/sections`, 'sections must be an array.')
  }

  const repeaterPaths = new Set()
  if (Array.isArray(schema.sections)) {
    schema.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${contextPath}/sections/${sectionIndex}`
      if (typeof section === 'string') return
      if (!isObject(section)) {
        pushIssue(issues, sectionPath, 'Section must be a string or object.')
        return
      }
      if (section.fields && !Array.isArray(section.fields)) {
        pushIssue(issues, `${sectionPath}/fields`, 'fields must be an array when provided.')
      }
      const isRepeatableSection = normalizeRepeatableSection(section)
      const sectionKey = normalizeSegment(section.key || section.path || section.id || `section_${sectionIndex + 1}`)
      const sectionParentPath = isRepeatableSection ? sectionKey : ''
      if (isRepeatableSection) {
        if (!String(section.key || section.path || section.id || '').trim()) {
          pushIssue(issues, `${sectionPath}/key`, 'Repeatable sections require key/path/id metadata.')
        }
        repeaterPaths.add(sectionKey)
      }
      collectRepeaterPaths(section.fields || [], sectionParentPath, issues, `${sectionPath}/fields`, repeaterPaths)
      // Validate optional visibleIf conditions: references must stay within this
      // section's field scope (per-row for repeatable sections).
      validateVisibleIfScope(section.fields || [], issues, `${sectionPath}/fields`)
    })
  }

  if (issues.length) {
    throw validationError('Form definition schema validation failed.', issues)
  }

  return {
    schema,
    repeaterPaths
  }
}
