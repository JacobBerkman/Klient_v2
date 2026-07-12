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

function assertOptionalEventId(value) {
  if (value === undefined || value === null) return null
  const normalized = toTrimmedString(value)
  if (!normalized) {
    throw new Error('Profile source eventId must be a non-empty string when provided.')
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
  const eventId = source.eventId

  const normalized = {
    sourceCity: assertRequiredString(sourceCity, 'sourceCity'),
    sourceVenue: assertRequiredString(sourceVenue, 'sourceVenue'),
    sourceDate: assertIsoSourceDate(sourceDate),
    campaignId: assertOptionalCampaignId(campaignId)
  }

  // eventId is the optional linkage to a marketing events row. It is preserved
  // through normalization (validated as a non-empty string when present) but is
  // NOT part of the human-readable displayValue. Existence + firm-scoping of the
  // referenced event is enforced at write time in the store (normalize is a pure
  // function with no DB access), which also auto-fills any missing
  // city/venue/date from the event before calling this.
  const validatedEventId = assertOptionalEventId(eventId)

  return {
    ...normalized,
    ...(validatedEventId ? { eventId: validatedEventId } : {}),
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
