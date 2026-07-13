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

function summarizeTransform(transform) {
  if (!transform || typeof transform !== 'object') return null
  const type = String(transform.type || '').trim()
  if (!type) return null
  const summary = { type }
  if (type === 'currency' && transform.currency) summary.currency = String(transform.currency)
  if (type === 'expression' && transform.expression) summary.expression = String(transform.expression)
  return summary
}

function resolveSourceValue({ sourcePath, profile, submission, spouse, household }) {
  if (!sourcePath) return undefined
  if (sourcePath.startsWith('submission.')) {
    return resolvePathFromObject(submission?.data || {}, sourcePath.replace(/^submission\./, ''))
  }
  if (sourcePath.startsWith('form.')) {
    return resolvePathFromObject(submission?.data || {}, sourcePath.replace(/^form\./, ''))
  }
  if (sourcePath.startsWith('profile.')) {
    return resolvePathFromObject(profile || {}, sourcePath.replace(/^profile\./, ''))
  }
  // spouse.* / household.* resolve from firm-scoped related rows supplied by the
  // caller; a missing spouse/household simply resolves to undefined so exports
  // stay non-fatal (renderers skip empty values).
  if (sourcePath.startsWith('spouse.')) {
    return resolvePathFromObject(spouse || {}, sourcePath.replace(/^spouse\./, ''))
  }
  if (sourcePath.startsWith('household.')) {
    return resolvePathFromObject(household || {}, sourcePath.replace(/^household\./, ''))
  }
  const submissionValue = resolvePathFromObject(submission?.data || {}, sourcePath)
  if (submissionValue !== undefined) return submissionValue
  const profileValue = resolvePathFromObject(profile || {}, sourcePath)
  if (profileValue !== undefined) return profileValue
  return resolvePathFromObject(submission || {}, sourcePath)
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

function addWarning(warnings, code, message, options = {}) {
  warnings.push({
    code,
    message,
    severity: options.severity || 'warning',
    blocking: options.blocking === true
  })
}

function buildRowId(rule = {}, index = 0) {
  return createHash('sha1')
    .update(
      stableSerialize({
        index,
        pdfField: String(rule.pdfField || '').trim(),
        sourcePath: String(rule.sourcePath || '').trim(),
        fieldLabel: String(rule.fieldLabel || '').trim()
      })
    )
    .digest('hex')
    .slice(0, 12)
}

export function canonicalizeMappings(inputMappings = []) {
  return convertLegacyMappingRules(inputMappings).map((rule) => ({ ...rule }))
}

export function computeMappingVersionHash(mappings = []) {
  return createHash('sha256')
    .update(stableSerialize(canonicalizeMappings(mappings)))
    .digest('hex')
}

// Projects a firm-scoped profile row down to the non-sensitive fields the
// mapping vocabulary exposes (spouse.* / household.primary.*). Encrypted
// profile.pii never crosses this boundary.
export function sanitizeRelatedExportProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  return {
    id: profile.id || null,
    firstName: profile.firstName || null,
    lastName: profile.lastName || null,
    email: profile.email || null,
    phone: profile.phone || null,
    dateOfBirth: profile.dateOfBirth || null
  }
}

export function buildHouseholdExportContext(householdRow, primaryProfile = null) {
  if (!householdRow || typeof householdRow !== 'object') return null
  return {
    id: householdRow.id || null,
    name: householdRow.name || null,
    primary: sanitizeRelatedExportProfile(primaryProfile)
  }
}

// Resolves the export client's spouse + household rows via injected firm-scoped
// lookups. Null-safe: missing linkage yields nulls, which downstream resolution
// treats as empty values (non-fatal, PDF_FIELD_SKIPPED_EMPTY / blank cell).
export function buildRelatedExportEntities(profile, { getProfileRow, getHouseholdRow, firmId } = {}) {
  const spouseRow =
    profile?.spouseClientId && typeof getProfileRow === 'function'
      ? getProfileRow(profile.spouseClientId, { firmId })
      : null
  const householdRow =
    profile?.householdId && typeof getHouseholdRow === 'function'
      ? getHouseholdRow(profile.householdId, { firmId })
      : null
  const primaryRow =
    householdRow?.primaryClientId && typeof getProfileRow === 'function'
      ? getProfileRow(householdRow.primaryClientId, { firmId })
      : null
  return {
    spouse: sanitizeRelatedExportProfile(spouseRow),
    household: buildHouseholdExportContext(householdRow, primaryRow)
  }
}

export function resolveExportData({
  mappings = [],
  profile = null,
  submission = null,
  spouse = null,
  household = null
} = {}) {
  const canonicalMappings = canonicalizeMappings(mappings)
  const rows = canonicalMappings.map((rule, index) => {
    const sourcePath = String(rule.sourcePath || '').trim()
    // Auto-built rules keep the generated form key as the primary source (so a
    // client's own submitted answer always wins) and carry the auto-mapped
    // profile/spouse/household path as a fallback, which fills the field from
    // firm records when the client left it blank. Without the fallback the two
    // intents conflict: mapping straight to profile.* would silently ignore
    // what the client typed into the very form the PDF generated.
    const fallbackSourcePath = String(rule.fallbackSourcePath || '').trim()
    const primaryValue = resolveSourceValue({ sourcePath, profile, submission, spouse, household })
    const rawValue =
      primaryValue === undefined || primaryValue === null || primaryValue === ''
        ? (resolveSourceValue({ sourcePath: fallbackSourcePath, profile, submission, spouse, household }) ??
          primaryValue)
        : primaryValue
    const transformed = applyTransform(rawValue, rule?.transform || null)
    const value = normalizeResolvedValue(rule, rawValue)
    const warnings = []
    const isRequired = rule?.required === true
    if (sourcePath && rawValue === undefined) {
      addWarning(warnings, 'UNRESOLVED_SOURCE_PATH', `No value found for source path "${sourcePath}".`, {
        blocking: isRequired
      })
    }
    if (
      (transformed === null || transformed === undefined || transformed === '') &&
      Object.hasOwn(rule || {}, 'defaultValue')
    ) {
      addWarning(warnings, 'FALLBACK_DEFAULT_APPLIED', 'Default value applied after transform.')
    }
    if (rawValue != null && (transformed === null || transformed === undefined || transformed === '')) {
      addWarning(warnings, 'NULL_AFTER_TRANSFORM', 'Transform produced an empty value from a non-empty source.', {
        blocking: isRequired
      })
    }
    const targetType = String(rule.targetType || '').trim()
    if (targetType && value != null) {
      const valueType = Array.isArray(value) ? 'array' : typeof value
      const normalizedType =
        valueType === 'number' || valueType === 'boolean' || valueType === 'string' ? valueType : 'text'
      const compatible =
        normalizedType === targetType ||
        (targetType === 'text' && normalizedType === 'string') ||
        (targetType === 'select' && normalizedType === 'string') ||
        (targetType === 'date' && normalizedType === 'string') ||
        (targetType === 'checkbox' && ['boolean', 'string'].includes(normalizedType))
      if (!compatible) {
        addWarning(
          warnings,
          'TYPE_MISMATCH_HINT',
          `Resolved value type "${normalizedType}" may not match targetType "${targetType}".`
        )
      }
    }
    return {
      rowId: buildRowId(rule, index),
      rowIndex: index,
      pdfField: String(rule.pdfField || '').trim(),
      sourcePath,
      targetType,
      transform: summarizeTransform(rule?.transform || null),
      value,
      rawValue: rawValue === undefined ? null : rawValue,
      warnings,
      warningSummary: {
        total: warnings.length,
        blocking: warnings.filter((warning) => warning.blocking).length,
        nonBlocking: warnings.filter((warning) => !warning.blocking).length
      }
    }
  })
  const warningsCount = rows.reduce((count, row) => count + row.warnings.length, 0)
  const blockingWarningsCount = rows.reduce(
    (count, row) => count + row.warnings.filter((warning) => warning.blocking).length,
    0
  )

  return {
    rows,
    mappingVersionHash: computeMappingVersionHash(canonicalMappings),
    warningsCount,
    blockingWarningsCount
  }
}
