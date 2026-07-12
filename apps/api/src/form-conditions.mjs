// Conditional (show-if) form field evaluation — server-side canonical copy.
//
// DUPLICATION NOTE: the repo shares no code between apps/api (Node .mjs) and
// apps/web (TS/Vite). This module is intentionally duplicated in
// apps/web/src/lib/formConditions.ts with IDENTICAL semantics. Any change to
// evaluation rules here MUST be mirrored there (and vice versa), and both have
// their own unit tests. Keep the two in lock-step.
//
// v1 supports a SINGLE condition per field (no boolean composition / and-or):
//   field.visibleIf = { field, op, value? }
//     op: 'equals' | 'notEquals' | 'in' | 'notEmpty'
//     value: required for every op except 'notEmpty'
// The `field` reference must point at a SIBLING field key in the same field
// scope (same section, or the same repeatable row). The schema validator
// (form-definition-validator.mjs) enforces those authoring constraints; this
// module only evaluates already-valid definitions and fails OPEN (renders the
// field) on anything it does not understand.

export const VISIBLE_IF_OPS = Object.freeze(['equals', 'notEquals', 'in', 'notEmpty'])

// The identifier a field is keyed by in submission data. Matches the web
// renderer (which reads/writes data[field.key]) with path/name/id fallbacks so
// legacy/generated field shapes resolve consistently.
export function fieldKey(field) {
  if (!field || typeof field !== 'object') return ''
  return String(field.key ?? field.path ?? field.name ?? field.id ?? '')
}

function valueToString(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

// Empty for the purpose of `notEmpty` / required checks: undefined, null, an
// empty/whitespace string, or an empty array. Booleans (checkbox state) are
// considered present values, not empty.
export function isEmptyValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

// Evaluate a single visibleIf condition against a scope of sibling values.
// Returns true (visible) for unknown operators so a malformed condition never
// hides content silently — the validator is the gate that blocks bad ops.
export function evaluateCondition(condition, values) {
  if (!condition || typeof condition !== 'object') return true
  const scope = values && typeof values === 'object' ? values : {}
  const actual = scope[condition.field]
  switch (condition.op) {
    case 'equals':
      return valueToString(actual) === valueToString(condition.value)
    case 'notEquals':
      return valueToString(actual) !== valueToString(condition.value)
    case 'in':
      return Array.isArray(condition.value) && condition.value.map(valueToString).includes(valueToString(actual))
    case 'notEmpty':
      return !isEmptyValue(actual)
    default:
      return true
  }
}

// Is this field visible given its sibling scope? Fields without visibleIf are
// always visible (backwards compatible: absent condition = shown).
export function isFieldVisible(field, values) {
  if (!field || typeof field !== 'object' || !field.visibleIf) return true
  return evaluateCondition(field.visibleIf, values)
}

function sectionStorageKey(section, index) {
  const base = String(section?.key || section?.id || section?.title || `section_${index + 1}`)
  return base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

function isRepeatableSection(section) {
  if (!section || typeof section !== 'object') return false
  if (section.repeatable === true) return true
  if (section.repeater === true) return true
  return String(section.type || '')
    .trim()
    .toLowerCase() === 'repeater'
}

// Collect required fields that are missing given the submitted data, applying
// visibleIf semantics: a field hidden by its condition is NOT required, even if
// required:true. Repeatable sections evaluate per-row against that row's values.
//
// Returns an array of { sectionKey, fieldKey, rowIndex? } descriptors. An empty
// array means the submission satisfies every required, currently-visible field.
export function collectMissingRequiredFields(sections, data) {
  const missing = []
  const values = data && typeof data === 'object' ? data : {}
  const sectionList = Array.isArray(sections) ? sections : []

  sectionList.forEach((section, index) => {
    if (!section || typeof section !== 'object') return
    const fields = Array.isArray(section.fields) ? section.fields : []

    if (isRepeatableSection(section)) {
      const storageKey = sectionStorageKey(section, index)
      const rows = Array.isArray(values[storageKey]) ? values[storageKey] : []
      rows.forEach((row, rowIndex) => {
        const rowScope = row && typeof row === 'object' ? row : {}
        for (const field of fields) {
          if (field?.required !== true) continue
          if (!isFieldVisible(field, rowScope)) continue
          if (isEmptyValue(rowScope[fieldKey(field)])) {
            missing.push({ sectionKey: storageKey, fieldKey: fieldKey(field), rowIndex })
          }
        }
      })
      return
    }

    for (const field of fields) {
      if (field?.required !== true) continue
      if (!isFieldVisible(field, values)) continue
      if (isEmptyValue(values[fieldKey(field)])) {
        missing.push({ sectionKey: sectionStorageKey(section, index), fieldKey: fieldKey(field) })
      }
    }
  })

  return missing
}
