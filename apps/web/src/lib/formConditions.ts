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
import type { FormField } from './types'

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
