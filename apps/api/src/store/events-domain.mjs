import { randomUUID } from 'node:crypto'
import {
  requireFirmContext,
  validateEntityOwnership as validateTenantEntityOwnership
} from '../modules/shared/tenancy.mjs'
import {
  deleteMeetingRow,
  getEventRow,
  getMeetingRow,
  getProfileRow,
  listEventRowsByFirm,
  listMeetingRowsByFirm,
  listMeetingRowsByProfile,
  listProfileRows,
  upsertEventRow,
  upsertMeetingRow
} from '../storage.mjs'
import { MEETING_TYPES } from './constants.mjs'
import { now, parseIso, requirePermission } from './helpers.mjs'

// Marketing-event normalization. Frozen validation (name required, ISO date
// when provided) mirroring the profile-source date rule, so events and profile
// sources agree on calendar validity.
const EVENT_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
function normalizeEventInput(input = {}) {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('Event requires a non-empty name.')
  const venue = input.venue == null ? '' : String(input.venue).trim()
  const city = input.city == null ? '' : String(input.city).trim()
  let eventDate = null
  if (input.eventDate != null && String(input.eventDate).trim() !== '') {
    const raw = String(input.eventDate).trim()
    if (!EVENT_ISO_DATE_PATTERN.test(raw)) {
      throw new Error('Event eventDate must use YYYY-MM-DD format.')
    }
    if (!Number.isFinite(Date.parse(`${raw}T00:00:00.000Z`))) {
      throw new Error('Event eventDate is not a valid calendar date.')
    }
    eventDate = raw
  }
  return { name, venue, city, eventDate }
}

export function createEventsDomain(ctx) {
  const { addAudit, persist } = ctx
  return {
    listEvents(user, { includeArchived = false } = {}) {
      requireFirmContext(user, { method: 'store.listEvents' })
      requirePermission(user, 'profiles:read')
      return listEventRowsByFirm(user.firmId, { includeArchived })
    },
    getEvent(user, eventId) {
      const firmContext = requireFirmContext(user, { method: 'store.getEvent' })
      requirePermission(user, 'profiles:read')
      return validateTenantEntityOwnership(firmContext, getEventRow(eventId), { entityName: 'Event' })
    },
    createEvent(user, input) {
      requireFirmContext(user, { method: 'store.createEvent' })
      requirePermission(user, 'profiles:write')
      const normalized = normalizeEventInput(input || {})
      const createdAt = now()
      const event = {
        id: randomUUID(),
        firmId: user.firmId,
        name: normalized.name,
        venue: normalized.venue,
        city: normalized.city,
        eventDate: normalized.eventDate,
        archivedAt: null,
        createdByUserId: user.id,
        createdAt,
        updatedAt: createdAt
      }
      upsertEventRow(event)
      addAudit(user.firmId, user.id, 'event', event.id, 'event.created', { name: event.name })
      persist()
      return event
    },
    updateEvent(user, eventId, patch = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.updateEvent' })
      requirePermission(user, 'profiles:write')
      const event = validateTenantEntityOwnership(firmContext, getEventRow(eventId), { entityName: 'Event' })
      // Re-validate the merged record so partial patches still enforce the
      // name/date invariants.
      const normalized = normalizeEventInput({
        name: 'name' in patch ? patch.name : event.name,
        venue: 'venue' in patch ? patch.venue : event.venue,
        city: 'city' in patch ? patch.city : event.city,
        eventDate: 'eventDate' in patch ? patch.eventDate : event.eventDate
      })
      Object.assign(event, normalized, { updatedAt: now() })
      upsertEventRow(event)
      addAudit(user.firmId, user.id, 'event', event.id, 'event.updated', { fields: Object.keys(patch) })
      persist()
      return event
    },
    archiveEvent(user, eventId) {
      const firmContext = requireFirmContext(user, { method: 'store.archiveEvent' })
      requirePermission(user, 'profiles:write')
      const event = validateTenantEntityOwnership(firmContext, getEventRow(eventId), { entityName: 'Event' })
      if (event.archivedAt) {
        const error = new Error('Event is already archived.')
        error.statusCode = 409
        error.code = 'EVENT_ALREADY_ARCHIVED'
        error.details = { eventId }
        throw error
      }
      const archivedAt = now()
      event.archivedAt = archivedAt
      event.updatedAt = archivedAt
      upsertEventRow(event)
      addAudit(user.firmId, user.id, 'event', event.id, 'event.archived', { name: event.name })
      persist()
      return event
    },
    // --- Per-profile meetings -------------------------------------------------
    // Lightweight meeting log scoped to a profile + firm. Guarded at
    // canWriteProfiles-level (profiles:write for create/delete, profiles:read for
    // list) — meetings are per-profile advisory activity, squarely a
    // profile-management concern. Hard delete (list/create/delete only).
    listMeetings(user, profileId) {
      const firmContext = requireFirmContext(user, { method: 'store.listMeetings' })
      requirePermission(user, 'profiles:read')
      // Firm-scope the parent profile so a cross-firm id surfaces a tenancy error
      // instead of silently returning an empty list.
      validateTenantEntityOwnership(firmContext, getProfileRow(profileId), { entityName: 'Profile' })
      return listMeetingRowsByProfile(user.firmId, profileId)
    },
    createMeeting(user, profileId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.createMeeting' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), { entityName: 'Profile' })
      const rawType = String(input.meetingType ?? input.type ?? '').trim().toLowerCase()
      const meetingType = MEETING_TYPES.has(rawType) ? rawType : 'other'
      let scheduledAt = null
      if (input.scheduledAt != null && String(input.scheduledAt).trim() !== '') {
        const raw = String(input.scheduledAt).trim()
        const parsed = Date.parse(raw)
        if (!Number.isFinite(parsed)) {
          throw new Error('Meeting scheduledAt must be a valid date/time.')
        }
        scheduledAt = new Date(parsed).toISOString()
      }
      const notes = input.notes == null ? '' : String(input.notes).trim().slice(0, 2000)
      const createdAt = now()
      const meeting = {
        id: randomUUID(),
        firmId: user.firmId,
        profileId: profile.id,
        meetingType,
        scheduledAt,
        notes,
        createdBy: user.id,
        createdAt
      }
      upsertMeetingRow(meeting)
      addAudit(user.firmId, user.id, 'meeting', meeting.id, 'meeting.created', {
        profileId: profile.id,
        meetingType
      })
      persist()
      return meeting
    },
    deleteMeeting(user, profileId, meetingId) {
      const firmContext = requireFirmContext(user, { method: 'store.deleteMeeting' })
      requirePermission(user, 'profiles:write')
      validateTenantEntityOwnership(firmContext, getProfileRow(profileId), { entityName: 'Profile' })
      const meeting = getMeetingRow(meetingId, { firmId: user.firmId })
      if (!meeting || meeting.profileId !== profileId) {
        const error = new Error('Meeting not found.')
        error.statusCode = 404
        error.code = 'MEETING_NOT_FOUND'
        error.details = { meetingId }
        throw error
      }
      deleteMeetingRow(meetingId, user.firmId)
      addAudit(user.firmId, user.id, 'meeting', meetingId, 'meeting.deleted', { profileId })
      persist()
      return { ok: true }
    },
    // Firm-wide upcoming meetings within a forward window (dashboard card).
    listUpcomingMeetings(user, { windowDays = 14 } = {}) {
      requireFirmContext(user, { method: 'store.listUpcomingMeetings' })
      requirePermission(user, 'profiles:read')
      const nowMs = parseIso(process.env.TEST_NOW || '') || Date.now()
      const horizon = nowMs + windowDays * 86_400_000
      const profilesById = new Map(listProfileRows({ firmId: user.firmId }).map((entry) => [entry.id, entry]))
      return listMeetingRowsByFirm(user.firmId)
        .filter((meeting) => {
          if (!meeting.scheduledAt) return false
          const at = parseIso(meeting.scheduledAt)
          return at >= nowMs && at <= horizon
        })
        .map((meeting) => {
          const profile = profilesById.get(meeting.profileId)
          return {
            ...meeting,
            profileName: profile ? `${profile.firstName} ${profile.lastName}`.trim() : null,
            profileArchived: Boolean(profile?.archivedAt)
          }
        })
        .filter((meeting) => !meeting.profileArchived)
        .sort((a, b) => parseIso(a.scheduledAt) - parseIso(b.scheduledAt))
    }
  }
}
