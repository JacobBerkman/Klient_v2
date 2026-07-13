// Conservative PDF-field-name → mapping-source-path heuristics used by the
// template auto-build pipeline and the POST /mappings/auto-map action.
//
// Field names are normalized (lowercased, non-alphanumerics stripped) and
// matched against a synonym table with optional client/spouse prefixes. When a
// name is not confidently recognized the suggester returns null and callers
// keep the existing behavior (map to the generated form's own key), so the
// heuristics can only add profile/spouse/household mappings — never break the
// default auto-build contract.
//
// PII note: only non-sensitive vocabulary paths are ever suggested. Encrypted
// profile.pii values (SSN, tax ids) are not mapping-exposed and must never be
// added here.

const LEAF_SYNONYMS = new Map()

function registerLeaf(field, type, synonyms) {
  for (const synonym of synonyms) {
    LEAF_SYNONYMS.set(synonym, { field, type })
  }
}

registerLeaf('firstName', 'text', ['first', 'firstname', 'fname', 'givenname', 'given'])
registerLeaf('lastName', 'text', ['last', 'lastname', 'lname', 'surname', 'familyname'])
registerLeaf('email', 'text', ['email', 'emailaddress'])
registerLeaf('phone', 'text', [
  'phone',
  'phonenumber',
  'phoneno',
  'telephone',
  'tel',
  'mobile',
  'mobilephone',
  'cell',
  'cellphone'
])
registerLeaf('dateOfBirth', 'date', ['dob', 'dateofbirth', 'birthdate', 'birthday'])

// Prefixes that mark a field as belonging to the spouse/partner/co-applicant.
const SPOUSE_PREFIXES = ['spouse', 'partner', 'coapplicant', 'coclient', 'co']
// Prefixes that mark a field as belonging to the primary client; stripped so
// e.g. client_first_name / applicant_email / primary_dob resolve to profile.*.
const CLIENT_PREFIXES = ['client', 'applicant', 'primary']
// Whole-name matches for the household display name. Deliberately excludes
// "family_name"/"familyname" (a surname synonym) to stay conservative.
const HOUSEHOLD_NAME_KEYS = new Set(['household', 'householdname', 'hhname'])

export function normalizePdfFieldName(fieldName) {
  return String(fieldName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

// Mirrors the key normalization template-form-builder uses when it maps a PDF
// field to the generated form's own key — the "auto-build default" sourcePath.
export function defaultSourcePathForField(fieldName, fallback = 'field') {
  const normalized = String(fieldName || fallback)
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return normalized || fallback
}

function leafFor(normalized) {
  return LEAF_SYNONYMS.get(normalized) || null
}

// Returns { sourcePath, type } for a confident match, otherwise null.
export function suggestMapping(fieldName) {
  const normalized = normalizePdfFieldName(fieldName)
  if (!normalized) return null

  if (HOUSEHOLD_NAME_KEYS.has(normalized)) {
    return { sourcePath: 'household.name', type: 'text' }
  }

  for (const prefix of SPOUSE_PREFIXES) {
    if (normalized.length > prefix.length && normalized.startsWith(prefix)) {
      const leaf = leafFor(normalized.slice(prefix.length))
      if (leaf) return { sourcePath: `spouse.${leaf.field}`, type: leaf.type }
    }
  }

  for (const prefix of CLIENT_PREFIXES) {
    if (normalized.length > prefix.length && normalized.startsWith(prefix)) {
      const leaf = leafFor(normalized.slice(prefix.length))
      if (leaf) return { sourcePath: `profile.${leaf.field}`, type: leaf.type }
    }
  }

  const leaf = leafFor(normalized)
  if (leaf) return { sourcePath: `profile.${leaf.field}`, type: leaf.type }
  return null
}

export function suggestSourcePath(fieldName) {
  return suggestMapping(fieldName)?.sourcePath ?? null
}

// Bulk helper: Map of fieldName → suggested sourcePath (confident matches only).
export function suggestSourcePaths(fieldNames = []) {
  const suggestions = new Map()
  for (const fieldName of Array.isArray(fieldNames) ? fieldNames : []) {
    const suggestion = suggestSourcePath(fieldName)
    if (suggestion) suggestions.set(String(fieldName), suggestion)
  }
  return suggestions
}
