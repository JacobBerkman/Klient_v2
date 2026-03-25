import { createHash } from 'node:crypto'
import { convertLegacyMappingRules } from './modules/templates/schema/mapping-rules-validator.mjs'

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function resolvePathFromObject(value, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, segment) => (current == null ? undefined : current[segment]), value)
}

function normalizeDate(value) {
  if (value == null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().slice(0, 10)
}

function normalizeCurrency(value, options = {}) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return String(value)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: options.currency || 'USD',
    minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(numeric)
}

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D+/g, '')
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return value == null ? null : String(value)
}

function applyTransform(value, transform) {
  if (!transform || typeof transform !== 'object') return value
  switch (transform.type) {
    case 'date':
      return normalizeDate(value)
    case 'currency':
      return normalizeCurrency(value, transform)
    case 'phone':
      return normalizePhone(value)
    case 'checkbox':
      return value ? 'Yes' : 'No'
    case 'expression':
      return String(transform.expression || '').trim() === 'value' ? value : String(value ?? '')
    default:
      return value
  }
}

function resolveSourceValue({ sourcePath, profile, submission }) {
  if (!sourcePath) return undefined
  if (sourcePath.startsWith('profile.')) {
    return resolvePathFromObject(profile || {}, sourcePath.replace(/^profile\./, ''))
  }
  return resolvePathFromObject(submission?.data || {}, sourcePath)
}

function normalizeResolvedValue(rule, rawValue) {
  const transformed = applyTransform(rawValue, rule?.transform || null)
  if (transformed === undefined || transformed === null || transformed === '') {
    if (Object.hasOwn(rule || {}, 'defaultValue')) {
      return rule.defaultValue
    }
    return null
  }
  return transformed
}

export function canonicalizeMappings(inputMappings = []) {
  return convertLegacyMappingRules(inputMappings).map((rule) => ({ ...rule }))
}

export function computeMappingVersionHash(mappings = []) {
  return createHash('sha256').update(stableSerialize(canonicalizeMappings(mappings))).digest('hex')
}

export function resolveExportData({ mappings = [], profile = null, submission = null } = {}) {
  const canonicalMappings = canonicalizeMappings(mappings)
  const rows = canonicalMappings.map((rule) => {
    const sourcePath = String(rule.sourcePath || '').trim()
    const rawValue = resolveSourceValue({ sourcePath, profile, submission })
    const value = normalizeResolvedValue(rule, rawValue)
    return {
      pdfField: String(rule.pdfField || '').trim(),
      sourcePath,
      value,
      rawValue: rawValue === undefined ? null : rawValue
    }
  })

  return {
    rows,
    mappingVersionHash: computeMappingVersionHash(canonicalMappings)
  }
}
