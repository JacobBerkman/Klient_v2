import type { FormField, FormSection } from './types'

export function sectionStorageKey(section: FormSection, index: number) {
  const base = String(section.key || section.id || section.title || `section_${index + 1}`)
  return base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

export function fieldInputType(field: FormField) {
  switch (field.type) {
    case 'checkbox':
    case 'boolean':
      return 'checkbox'
    case 'number':
      return 'number'
    case 'date':
      return 'date'
    case 'email':
      return 'email'
    default:
      return 'text'
  }
}

export function scalarFieldValue(data: Record<string, unknown>, field: FormField) {
  const value = data[field.key]
  return value === undefined || value === null ? '' : String(value)
}

export function repeaterRows(data: Record<string, unknown>, section: FormSection, index: number) {
  const value = data[sectionStorageKey(section, index)]
  return Array.isArray(value) ? value : []
}

export function updateRepeaterRow(
  data: Record<string, unknown>,
  section: FormSection,
  sectionIndex: number,
  rowIndex: number,
  nextRow: Record<string, unknown>
) {
  const key = sectionStorageKey(section, sectionIndex)
  const rows = repeaterRows(data, section, sectionIndex)
  return {
    ...data,
    [key]: rows.map((row, index) => (index === rowIndex ? nextRow : row))
  }
}

export function appendRepeaterRow(data: Record<string, unknown>, section: FormSection, sectionIndex: number) {
  const key = sectionStorageKey(section, sectionIndex)
  const rows = repeaterRows(data, section, sectionIndex)
  const blankRow = Object.fromEntries((section.fields || []).map((field) => [field.key, '']))
  return {
    ...data,
    [key]: [...rows, blankRow]
  }
}

export function removeRepeaterRow(
  data: Record<string, unknown>,
  section: FormSection,
  sectionIndex: number,
  rowIndex: number
) {
  const key = sectionStorageKey(section, sectionIndex)
  const rows = repeaterRows(data, section, sectionIndex)
  return {
    ...data,
    [key]: rows.filter((_row, index) => index !== rowIndex)
  }
}
