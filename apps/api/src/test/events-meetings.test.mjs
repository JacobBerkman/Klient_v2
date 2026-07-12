import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-events-meetings-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-events-meetings'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store, firmName = 'Events Test Firm') {
  const session = store.register({
    firmName,
    firstName: 'Pat',
    lastName: 'Operator',
    email: `pat-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'EventsSecure123!'
  })
  return store.requireUser(session.token)
}

// --- Events CRUD + firm scoping + archived exclusion -------------------------

test('event CRUD: create validates name and date, list/update/archive round-trip', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const event = store.createEvent(user, {
    name: 'Spring Seminar',
    venue: 'Grand Hotel',
    city: 'Austin',
    eventDate: '2026-03-10'
  })
  assert.equal(event.name, 'Spring Seminar')
  assert.equal(event.venue, 'Grand Hotel')
  assert.equal(event.city, 'Austin')
  assert.equal(event.eventDate, '2026-03-10')
  assert.equal(event.archivedAt, null)
  assert.equal(event.firmId, user.firmId)

  assert.throws(() => store.createEvent(user, { name: '' }), /non-empty name/)
  assert.throws(() => store.createEvent(user, { name: 'Bad', eventDate: '03-10-2026' }), /YYYY-MM-DD/)
  assert.throws(() => store.createEvent(user, { name: 'Bad', eventDate: '2026-13-40' }), /valid calendar date/)

  const updated = store.updateEvent(user, event.id, { name: 'Spring Seminar 2026', city: 'Dallas' })
  assert.equal(updated.name, 'Spring Seminar 2026')
  assert.equal(updated.city, 'Dallas')
  assert.equal(updated.venue, 'Grand Hotel', 'unspecified fields preserved')

  const audit = store.listAudit(user)
  assert.ok(audit.find((e) => e.action === 'event.created' && e.entityId === event.id))
  assert.ok(audit.find((e) => e.action === 'event.updated' && e.entityId === event.id))
})

test('event listing excludes archived by default; includeArchived opts back in; re-archive is 409', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const a = store.createEvent(user, { name: 'Kept', eventDate: '2026-01-01' })
  const b = store.createEvent(user, { name: 'Gone', eventDate: '2026-02-01' })

  const archived = store.archiveEvent(user, b.id)
  assert.ok(archived.archivedAt, 'archivedAt stamped')

  assert.deepEqual(
    store.listEvents(user).map((e) => e.id),
    [a.id],
    'archived event excluded from default listing'
  )
  assert.equal(store.listEvents(user, { includeArchived: true }).length, 2, 'includeArchived opts back in')

  assert.throws(
    () => store.archiveEvent(user, b.id),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'EVENT_ALREADY_ARCHIVED')
      return true
    }
  )
})

test('events are firm-scoped: another firm cannot read, update, or archive them', async () => {
  const store = await loadStore()
  const firmA = createAdvisor(store, 'Firm A')
  const firmB = createAdvisor(store, 'Firm B')

  const event = store.createEvent(firmA, { name: 'A-only', eventDate: '2026-04-01' })

  assert.equal(store.listEvents(firmB).length, 0, 'firm B sees none of firm A events')
  assert.throws(() => store.getEvent(firmB, event.id), /not found/i)
  assert.throws(() => store.updateEvent(firmB, event.id, { name: 'hijack' }), /not found/i)
  assert.throws(() => store.archiveEvent(firmB, event.id), /not found/i)

  // Firm A still owns it, untouched.
  assert.equal(store.getEvent(firmA, event.id).name, 'A-only')
})

// --- Source eventId validation + auto-fill ----------------------------------

test('profile source eventId: auto-fills missing venue/city/date from the event', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const event = store.createEvent(user, {
    name: 'Dinner',
    venue: 'Steakhouse',
    city: 'Houston',
    eventDate: '2026-05-05'
  })

  const profile = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Auto',
    lastName: 'Fill',
    stage: 'discovery',
    source: { eventId: event.id }
  })
  assert.equal(profile.source.sourceVenue, 'Steakhouse')
  assert.equal(profile.source.sourceCity, 'Houston')
  assert.equal(profile.source.sourceDate, '2026-05-05')
  assert.equal(profile.source.eventId, event.id)
  assert.equal(profile.source.displayValue, 'Houston X Steakhouse X 2026-05-05')
})

test('profile source eventId: explicit source fields win over event auto-fill', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const event = store.createEvent(user, { name: 'E', venue: 'V', city: 'C', eventDate: '2026-05-05' })

  const profile = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Explicit',
    lastName: 'Wins',
    stage: 'discovery',
    source: { eventId: event.id, sourceCity: 'Override City', sourceVenue: 'Override Venue' }
  })
  assert.equal(profile.source.sourceCity, 'Override City')
  assert.equal(profile.source.sourceVenue, 'Override Venue')
  assert.equal(profile.source.sourceDate, '2026-05-05', 'date still inherited from event')
})

test('profile source eventId: nonexistent, foreign, and archived events are rejected', async () => {
  const store = await loadStore()
  const firmA = createAdvisor(store, 'Firm A')
  const firmB = createAdvisor(store, 'Firm B')
  const foreignEvent = store.createEvent(firmB, { name: 'B event', venue: 'V', city: 'C', eventDate: '2026-06-01' })

  const expectRejected = (source) =>
    assert.throws(
      () =>
        store.createProfile(firmA, { kind: 'prospect', firstName: 'X', lastName: 'Y', stage: 'discovery', source }),
      (error) => {
        assert.equal(error.code, 'PROFILE_SOURCE_EVENT_NOT_FOUND')
        assert.equal(error.statusCode, 400)
        return true
      }
    )

  expectRejected({ eventId: 'does-not-exist' })
  expectRejected({ eventId: foreignEvent.id })

  const localEvent = store.createEvent(firmA, { name: 'Local', venue: 'V', city: 'C', eventDate: '2026-06-02' })
  store.archiveEvent(firmA, localEvent.id)
  expectRejected({ eventId: localEvent.id })
})

test('profile source eventId: updateProfile also validates and auto-fills', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const event = store.createEvent(user, { name: 'E', venue: 'Ballroom', city: 'Denver', eventDate: '2026-07-01' })
  const profile = store.createProfile(user, { kind: 'prospect', firstName: 'P', lastName: 'Q', stage: 'discovery' })

  const updated = store.updateProfile(user, profile.id, { source: { eventId: event.id } })
  assert.equal(updated.source.sourceVenue, 'Ballroom')
  assert.equal(updated.source.eventId, event.id)

  assert.throws(
    () => store.updateProfile(user, profile.id, { source: { eventId: 'ghost' } }),
    (error) => {
      assert.equal(error.code, 'PROFILE_SOURCE_EVENT_NOT_FOUND')
      return true
    }
  )
})

// --- Meetings CRUD + scoping ------------------------------------------------

test('meeting CRUD: create normalizes type/time, list newest-first, delete removes it', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const profile = store.createProfile(user, { kind: 'prospect', firstName: 'M', lastName: 'P', stage: 'discovery' })

  const early = store.createMeeting(user, profile.id, {
    meetingType: 'intro',
    scheduledAt: '2026-07-20T15:00',
    notes: 'first chat'
  })
  const late = store.createMeeting(user, profile.id, { meetingType: 'weird-type', scheduledAt: '2026-08-01T10:00' })

  assert.equal(early.meetingType, 'intro')
  assert.equal(early.notes, 'first chat')
  assert.ok(early.scheduledAt.endsWith('Z'), 'scheduledAt stored as ISO')
  assert.equal(late.meetingType, 'other', 'unknown type normalized to other')

  const list = store.listMeetings(user, profile.id)
  assert.deepEqual(list.map((m) => m.id), [late.id, early.id], 'newest scheduled first')

  const audit = store.listAudit(user)
  assert.ok(audit.find((e) => e.action === 'meeting.created' && e.entityId === early.id))

  const result = store.deleteMeeting(user, profile.id, early.id)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    store.listMeetings(user, profile.id).map((m) => m.id),
    [late.id],
    'deleted meeting gone'
  )
  assert.ok(store.listAudit(user).find((e) => e.action === 'meeting.deleted' && e.entityId === early.id))
})

test('meeting scoping: rejects invalid scheduledAt, foreign profile, and cross-profile delete', async () => {
  const store = await loadStore()
  const firmA = createAdvisor(store, 'Firm A')
  const firmB = createAdvisor(store, 'Firm B')
  const profileA = store.createProfile(firmA, { kind: 'prospect', firstName: 'A', lastName: 'P', stage: 'discovery' })
  const profileA2 = store.createProfile(firmA, { kind: 'prospect', firstName: 'A2', lastName: 'P', stage: 'discovery' })

  assert.throws(
    () => store.createMeeting(firmA, profileA.id, { meetingType: 'intro', scheduledAt: 'not-a-date' }),
    /valid date/i
  )

  // Foreign firm cannot list or create meetings on firm A's profile.
  assert.throws(() => store.listMeetings(firmB, profileA.id), /not found/i)
  assert.throws(() => store.createMeeting(firmB, profileA.id, { meetingType: 'intro' }), /not found/i)

  const meeting = store.createMeeting(firmA, profileA.id, { meetingType: 'review' })
  // Deleting via the wrong parent profile id is a 404 (meeting belongs to profileA).
  assert.throws(
    () => store.deleteMeeting(firmA, profileA2.id, meeting.id),
    (error) => {
      assert.equal(error.code, 'MEETING_NOT_FOUND')
      return true
    }
  )
  // Foreign firm cannot delete it either.
  assert.throws(() => store.deleteMeeting(firmB, profileA.id, meeting.id), /not found/i)
  assert.equal(store.listMeetings(firmA, profileA.id).length, 1, 'meeting untouched by rejected deletes')
})

test('upcoming meetings window returns firm meetings in the next N days, excluding archived profiles', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  process.env.TEST_NOW = '2026-07-10T00:00:00.000Z'
  try {
    const keep = store.createProfile(user, { kind: 'client', firstName: 'Keep', lastName: 'C' })
    const gone = store.createProfile(user, { kind: 'prospect', firstName: 'Gone', lastName: 'P', stage: 'discovery' })

    store.createMeeting(user, keep.id, { meetingType: 'review', scheduledAt: '2026-07-15T12:00:00.000Z' }) // in window
    store.createMeeting(user, keep.id, { meetingType: 'review', scheduledAt: '2026-08-30T12:00:00.000Z' }) // outside 14d
    store.createMeeting(user, keep.id, { meetingType: 'review', scheduledAt: '2026-07-01T12:00:00.000Z' }) // past
    const onArchived = store.createMeeting(user, gone.id, {
      meetingType: 'intro',
      scheduledAt: '2026-07-16T12:00:00.000Z'
    })

    let upcoming = store.listUpcomingMeetings(user, { windowDays: 14 })
    assert.equal(upcoming.length, 2, 'in-window meetings for both profiles before archive')

    store.archiveProfile(user, gone.id, {})
    upcoming = store.listUpcomingMeetings(user, { windowDays: 14 })
    assert.equal(upcoming.length, 1, 'meeting on archived profile excluded')
    assert.equal(upcoming[0].profileName, 'Keep C')
    assert.notEqual(upcoming[0].id, onArchived.id)
  } finally {
    delete process.env.TEST_NOW
  }
})

// --- Analytics: sourced attribution -----------------------------------------

test('analytics sourced attribution: per-venue/event/YoY counts with converted clients and archived excluded', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const seminar = store.createEvent(user, { name: 'Seminar', venue: 'Grand', city: 'Austin', eventDate: '2025-03-10' })
  const dinner = store.createEvent(user, { name: 'Dinner', venue: 'Bistro', city: 'Austin', eventDate: '2026-04-10' })

  // Seminar (2025): 2 prospects + 1 converted client.
  store.createProfile(user, { kind: 'prospect', firstName: 'S1', lastName: 'P', stage: 'discovery', source: { eventId: seminar.id } })
  store.createProfile(user, { kind: 'prospect', firstName: 'S2', lastName: 'P', stage: 'discovery', source: { eventId: seminar.id } })
  const converted = store.createProfile(user, { kind: 'prospect', firstName: 'S3', lastName: 'P', stage: 'discovery', source: { eventId: seminar.id } })
  store.convertProspectToClient(user, converted.id, {})

  // Dinner (2026): 1 prospect, archived (must be excluded).
  const archivedProspect = store.createProfile(user, { kind: 'prospect', firstName: 'D1', lastName: 'P', stage: 'discovery', source: { eventId: dinner.id } })
  store.archiveProfile(user, archivedProspect.id, {})
  // Dinner (2026): 1 live prospect.
  store.createProfile(user, { kind: 'prospect', firstName: 'D2', lastName: 'P', stage: 'discovery', source: { eventId: dinner.id } })

  const snap = store.buildAnalyticsSnapshot(user)
  const { byVenue, byEvent, yearOverYear } = snap.sourcedAttribution

  const grand = byVenue.find((v) => v.venue === 'Grand')
  assert.equal(grand.prospectCount, 2, 'converted client no longer counts as prospect')
  assert.equal(grand.clientCount, 1, 'converted client counted as client')
  assert.equal(grand.conversionRate, Number((1 / 3).toFixed(4)))

  const bistro = byVenue.find((v) => v.venue === 'Bistro')
  assert.equal(bistro.prospectCount, 1, 'archived prospect excluded')
  assert.equal(bistro.clientCount, 0)

  const seminarEvent = byEvent.find((e) => e.eventId === seminar.id)
  assert.equal(seminarEvent.name, 'Seminar')
  assert.equal(seminarEvent.prospectCount, 2)
  assert.equal(seminarEvent.clientCount, 1)

  const y2025 = yearOverYear.find((y) => y.year === '2025')
  const y2026 = yearOverYear.find((y) => y.year === '2026')
  assert.equal(y2025.prospectCount, 2)
  assert.equal(y2025.clientCount, 1)
  assert.equal(y2026.prospectCount, 1, 'archived prospect excluded from YoY')
  assert.equal(y2026.clientCount, 0)
  assert.deepEqual(yearOverYear.map((y) => y.year), ['2025', '2026'], 'years sorted ascending')
})
