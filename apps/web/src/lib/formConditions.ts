// Conditional (show-if) form field evaluation — web-side canonical copy.
//
// DUPLICATION NOTE: the repo shares no code between apps/web (TS/Vite) and
// apps/api (Node .mjs). This module is intentionally duplicated in
// apps/api/src/form-conditions.mjs with IDENTICAL semantics. Any change to
// evaluation rules here MUST be mirrored there (and vice versa). Keep the two
// in lock-step.
//
// v1 supports a SINGLE condition per field (no boolean composition). See the
// server copy for the full contract; the schema validator enforces authoring
// constraints, this module only evaluates already-valid definitions and fails
// OPEN (renders the field) on anything it does not understand.
import type { FormField, FormSection } from './types'

export const VISIBLE_IF_OPS = ['equals', 'notEquals', 'in', 'notEmpty'] as const

export type VisibleIfOp = (typeof VISIBLE_IF_OPS)[number]

export interface VisibleIfCondition {
  field: string
  op: VisibleIfOp
  value?: string | string[]
}

// The identifier a field is keyed by in submission data. Matches the renderer
// (which reads/writes data[field.key]) with path/name/id fallbacks.
export function fieldKey(field: FormField): string {
  if (!field || typeof field !== 'object') return ''
  return String(field.key ?? field.path ?? field.name ?? field.id ?? '')
}

// Is a section repeatable (row-array storage + per-row validation)? This MUST
// stay identical to the server helper in apps/api/src/form-conditions.mjs, which
// treats all three authoring shapes as repeatable: `repeatable: true`,
// `repeater: true`, or `type: 'repeater'`. The renderers previously gated only on
// `section.repeatable`, so a `{ type: 'repeater' }` template rendered flat on the
// client while the server validated (and stored) it as repeatable — a silent
// mismatch. Route every render/storage repeatable decision through this helper.
export function isRepeatableSection(section: FormSection | null | undefined): boolean {
  if (!section || typeof section !== 'object') return false
  const record = section as Record<string, unknown>
  if (record.repeatable === true) return true
  if (record.repeater === true) return true
  return String(record.type || '')
    .trim()
    .toLowerCase() === 'repeater'
}

function valueToString(value: unknown): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

// Empty for `notEmpty` / required checks: undefined, null, empty/whitespace
// string, or empty array. Booleans (checkbox state) count as present values.
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function readVisibleIf(field: FormField): VisibleIfCondition | null {
  const raw = (field as Record<string, unknown>).visibleIf
  if (!raw || typeof raw !== 'object') return null
  return raw as VisibleIfCondition
}

// Evaluate a single visibleIf condition against a scope of sibling values.
// Unknown operators return true (visible) so a malformed condition never hides
// content silently — the validator blocks bad ops at authoring time.
export function evaluateCondition(condition: VisibleIfCondition, values: Record<string, unknown>): boolean {
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
// always visible (absent condition = shown).
export function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  const condition = readVisibleIf(field)
  if (!condition) return true
  return evaluateCondition(condition, values)
}
