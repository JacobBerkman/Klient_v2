const SOURCE_SEPARATOR_PATTERN = /\s+X\s+/i
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function toTrimmedString(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function assertRequiredString(value, fieldName) {
  const normalized = toTrimmedString(value)
  if (!normalized) {
    throw new Error(`Profile source requires a non-empty ${fieldName}.`)
  }
  return normalized
}

function assertOptionalCampaignId(value) {
  if (value === undefined || value === null) return null
  const normalized = toTrimmedString(value)
  if (!normalized) {
    throw new Error('Profile source campaignId must be a non-empty string when provided.')
  }
  return normalized
}

function assertIsoSourceDate(value) {
  const normalized = assertRequiredString(value, 'sourceDate')
  if (!ISO_DATE_PATTERN.test(normalized)) {
    throw new Error('Profile sourceDate must use YYYY-MM-DD format.')
  }
  const parsedAt = Date.parse(`${normalized}T00:00:00.000Z`)
  if (!Number.isFinite(parsedAt)) {
    throw new Error('Profile sourceDate is not a valid calendar date.')
  }
  return normalized
}

export function formatProfileSourceDisplay(source) {
  return `${source.sourceCity} X ${source.sourceVenue} X ${source.sourceDate}`
}

export function parseLegacyProfileSource(value) {
  const normalized = toTrimmedString(value)
  if (!normalized) return null
  const parts = normalized.split(SOURCE_SEPARATOR_PATTERN)
  if (parts.length !== 3) {
    throw new Error('Legacy profile source must match "Location X Venue X YYYY-MM-DD".')
  }
  const [sourceCity, sourceVenue, sourceDate] = parts
  return {
    sourceCity: assertRequiredString(sourceCity, 'sourceCity'),
    sourceVenue: assertRequiredString(sourceVenue, 'sourceVenue'),
    sourceDate: assertIsoSourceDate(sourceDate),
    campaignId: null
  }
}

export function normalizeProfileSource(source) {
  if (source === undefined || source === null || source === '') return null

  if (typeof source === 'string') {
    const parsed = parseLegacyProfileSource(source)
    return parsed ? { ...parsed, displayValue: formatProfileSourceDisplay(parsed) } : null
  }

  if (typeof source !== 'object') {
    throw new Error('Profile source must be an object or legacy source string.')
  }

  const sourceCity = source.sourceCity ?? source.cityOrLocation
  const sourceVenue = source.sourceVenue ?? source.venue
  const sourceDate = source.sourceDate ?? source.occurredOn
  const campaignId = source.campaignId

  const normalized = {
    sourceCity: assertRequiredString(sourceCity, 'sourceCity'),
    sourceVenue: assertRequiredString(sourceVenue, 'sourceVenue'),
    sourceDate: assertIsoSourceDate(sourceDate),
    campaignId: assertOptionalCampaignId(campaignId)
  }

  return {
    ...normalized,
    displayValue: formatProfileSourceDisplay(normalized)
  }
}

export function migrateProfileSource(profile) {
  if (!profile || typeof profile !== 'object') return profile
  const normalizedSource = normalizeProfileSource(profile.source)
  if (!normalizedSource) {
    profile.source = null
    return profile
  }
  profile.source = normalizedSource
  return profile
}
