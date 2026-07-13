import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeCursor, encodeCursor } from '../modules/shared/cursor.mjs'

// Hermetic env: store.mjs/runtime.mjs hard-fail on the dev fallback secret.
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-list-pagination-suite'
process.env.AUTH_PROVIDER = 'local'
process.env.PII_KEY_PROVIDER = 'env'

// storage.mjs binds its SQLite file to process.cwd() at import time, so chdir
// into an isolated temp dir BEFORE the first import (loadStorage(tempDir)
// convention). The suite shares one database; tests isolate per registered
// firm.
const tempDir = mkdtempSync(join(tmpdir(), 'klient-list-pagination-'))
process.chdir(tempDir)
const storage = await import('../storage.mjs')
const { createStore } = await import('../store.mjs')
const store = createStore()

function registerFirm(label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `${label} ${suffix}`,
    firstName: 'Owner',
    lastName: label,
    email: `${label.toLowerCase()}.${suffix}@example.com`,
    password: 'ListPaginationPass123'
  })
  return store.requireUser(registered.token)
}

function seedProfile(user, firstName, lastName, extra = {}) {
  return store.createProfile(user, {
    kind: extra.kind || 'client',
    firstName,
    lastName,
    email: extra.email ?? `${firstName}.${lastName}@page.example`.toLowerCase(),
    ...(extra.ssn ? { ssn: extra.ssn } : {})
  })
}

function collectAllPages(user, options = {}, pageSize = 2) {
  const collected = []
  let cursor = null
  let guard = 0
  do {
    const page = store.listProfilesPage(user, { ...options, limit: pageSize, cursor })
    collected.push(...page.items)
    cursor = page.nextCursor
    guard += 1
    assert.ok(guard < 25, 'pagination must terminate')
  } while (cursor)
  return collected
}

test('profile pages are ordered, complete, and stable across page boundaries', () => {
  const user = registerFirm('StableFirm')
  for (const [first, last] of [
    ['Ada', 'Adams'],
    ['Bea', 'Baker'],
    ['Cal', 'Chen'],
    ['Dee', 'Davis'],
    ['Eve', 'Evans']
  ]) {
    seedProfile(user, first, last)
  }

  const firstPage = store.listProfilesPage(user, { limit: 2 })
  assert.equal(firstPage.items.length, 2)
  assert.deepEqual(
    firstPage.items.map((profile) => profile.lastName),
    ['Adams', 'Baker']
  )
  assert.ok(firstPage.nextCursor, 'more rows exist, so a cursor is returned')

  // A row inserted BEFORE the cursor position must not shift or duplicate the
  // remaining pages (keyset stability, unlike offset pagination).
  seedProfile(user, 'Aaron', 'Aardvark')

  const rest = []
  let cursor = firstPage.nextCursor
  while (cursor) {
    const page = store.listProfilesPage(user, { limit: 2, cursor })
    rest.push(...page.items)
    cursor = page.nextCursor
  }
  assert.deepEqual(
    rest.map((profile) => profile.lastName),
    ['Chen', 'Davis', 'Evans']
  )

  // A fresh full walk sees all six rows exactly once, in order.
  const everyone = collectAllPages(user)
  assert.deepEqual(
    everyone.map((profile) => profile.lastName),
    ['Aardvark', 'Adams', 'Baker', 'Chen', 'Davis', 'Evans']
  )
  assert.equal(new Set(everyone.map((profile) => profile.id)).size, 6, 'no duplicates across pages')
})

test('limit clamps to 1..200 and defaults to 50; legacy listProfiles stays a bare array', () => {
  const user = registerFirm('ClampFirm')
  seedProfile(user, 'One', 'Uno')
  seedProfile(user, 'Two', 'Dos')
  seedProfile(user, 'Three', 'Tres')

  // Zero/absent limits fall back to the default page size (matching the
  // queryAuditEventsPage semantics); negatives clamp up to 1.
  assert.equal(store.listProfilesPage(user, { limit: 0 }).items.length, 3)
  assert.equal(store.listProfilesPage(user, { limit: -5 }).items.length, 1)
  assert.equal(store.listProfilesPage(user, { limit: 1 }).items.length, 1)
  // Absurd limits clamp down to 200 (trivially satisfied here) and still work.
  assert.equal(store.listProfilesPage(user, { limit: 99999 }).items.length, 3)
  // Missing limit falls back to the default page size.
  assert.equal(store.listProfilesPage(user, {}).items.length, 3)

  // The legacy full-list method is untouched: bare array, legacy sort intact.
  const legacy = store.listProfiles(user, null, '')
  assert.ok(Array.isArray(legacy))
  assert.equal(legacy.length, 3)
})

test('search/kind/archived filters are SQL-pushed and match legacy filter semantics', () => {
  const user = registerFirm('FilterFirm')
  const ada = seedProfile(user, 'Ada', 'Lovelace', { email: 'ada@calc.example' })
  seedProfile(user, 'Grace', 'Hopper', { email: 'grace@navy.example' })
  const prospect = seedProfile(user, 'Alan', 'Turing', { kind: 'prospect', email: 'alan@bletchley.example' })

  // Search matches the legacy `${firstName} ${lastName} ${email}` haystack.
  const byName = store.listProfilesPage(user, { search: 'lovelace', limit: 10 })
  assert.deepEqual(
    byName.items.map((profile) => profile.id),
    [ada.id]
  )
  const byEmail = store.listProfilesPage(user, { search: 'BLETCHLEY', limit: 10 })
  assert.deepEqual(
    byEmail.items.map((profile) => profile.id),
    [prospect.id]
  )
  // Parity with the legacy in-memory filter for the same query.
  const legacyMatch = store.listProfiles(user, null, 'lovelace').map((profile) => profile.id)
  assert.deepEqual(
    byName.items.map((profile) => profile.id),
    legacyMatch
  )

  // Kind filter.
  const prospects = store.listProfilesPage(user, { kind: 'prospect', limit: 10 })
  assert.deepEqual(
    prospects.items.map((profile) => profile.id),
    [prospect.id]
  )

  // Archived rows are hidden by default and opt back in via includeArchived.
  store.archiveProfile(user, ada.id)
  assert.equal(
    store.listProfilesPage(user, { search: 'lovelace', limit: 10 }).items.length,
    0,
    'archived profiles are excluded by default'
  )
  const archivedIncluded = store.listProfilesPage(user, { search: 'lovelace', includeArchived: true, limit: 10 })
  assert.deepEqual(
    archivedIncluded.items.map((profile) => profile.id),
    [ada.id]
  )
})

test('cursors round-trip through the shared opaque encoding', () => {
  const raw = { lastName: 'Baker', firstName: 'Bea', id: 'profile-1' }
  const token = encodeCursor(raw)
  assert.equal(typeof token, 'string')
  assert.deepEqual(decodeCursor(token), raw)
  // Garbage tokens decode to null instead of throwing.
  assert.equal(decodeCursor('not-base64url-json'), null)
  assert.equal(decodeCursor(''), null)
  assert.equal(encodeCursor(null), null)
})

test('household pages order by name, attach members, and paginate', () => {
  const user = registerFirm('HouseFirm')
  const clientA = seedProfile(user, 'Prima', 'Client')
  const clientB = seedProfile(user, 'Secunda', 'Client')
  store.createHousehold(user, { name: 'Beta House', primaryClientId: clientB.id })
  const alpha = store.createHousehold(user, { name: 'Alpha House', primaryClientId: clientA.id })

  const firstPage = store.listHouseholdsPage(user, { limit: 1 })
  assert.equal(firstPage.items.length, 1)
  assert.equal(firstPage.items[0].name, 'Alpha House')
  assert.equal(firstPage.items[0].members.length, 1, 'members are attached like the legacy list')
  assert.ok(firstPage.nextCursor)

  const secondPage = store.listHouseholdsPage(user, { limit: 1, cursor: firstPage.nextCursor })
  assert.equal(secondPage.items[0].name, 'Beta House')
  assert.equal(secondPage.nextCursor, null)

  // Search over the promoted name column.
  const searched = store.listHouseholdsPage(user, { search: 'alpha', limit: 10 })
  assert.deepEqual(
    searched.items.map((household) => household.id),
    [alpha.id]
  )
})

test('submission pages enforce draft collaborator visibility in SQL and stay full', () => {
  const admin = registerFirm('DraftVisibilityFirm')
  const client = seedProfile(admin, 'Draft', 'Holder')

  const drafts = []
  for (let index = 0; index < 3; index += 1) {
    drafts.push(
      store.createFormSubmission(admin, {
        clientId: client.id,
        templateId: `template-${index}`,
        status: 'draft',
        data: {}
      })
    )
  }
  const submitted = []
  for (let index = 0; index < 3; index += 1) {
    submitted.push(
      store.createFormSubmission(admin, {
        clientId: client.id,
        templateId: `template-sub-${index}`,
        status: 'submitted',
        data: {}
      })
    )
  }

  // The creator sees all six across pages.
  const adminAll = []
  let cursor = null
  do {
    const page = store.listFormSubmissionsPage(admin, { limit: 2, cursor })
    adminAll.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(adminAll.length, 6)
  // Ordering: created_at DESC with rowid DESC tiebreak (newest insert first).
  assert.deepEqual(adminAll.map((entry) => entry.id).slice(0, 3), [submitted[2].id, submitted[1].id, submitted[0].id])
  // Items carry the same normalized collaborator shape as the legacy list.
  assert.ok(Array.isArray(adminAll[0].collaborators))

  // A non-collaborator advisor gets a FULL first page of the three submitted
  // records — the drafts are filtered in SQL, not post-hoc.
  const outsider = { id: `user-${randomUUID()}`, firmId: admin.firmId, role: 'advisor' }
  const outsiderPage = store.listFormSubmissionsPage(outsider, { limit: 3 })
  assert.equal(outsiderPage.items.length, 3, 'page stays full despite invisible drafts')
  assert.ok(outsiderPage.items.every((entry) => entry.status === 'submitted'))
  assert.equal(outsiderPage.nextCursor, null)

  // Explicit collaborator membership in the payload's collaborators array is
  // honored by the json_each EXISTS clause.
  const draftWithCollaborator = { ...drafts[0], collaborators: [{ userId: outsider.id, permission: 'write' }] }
  storage.upsertFormSubmission(draftWithCollaborator)
  const outsiderWithDraft = store.listFormSubmissionsPage(outsider, { limit: 10 })
  assert.equal(outsiderWithDraft.items.length, 4)
  assert.ok(outsiderWithDraft.items.some((entry) => entry.id === drafts[0].id))

  // Status filter narrows in SQL.
  const draftsOnly = store.listFormSubmissionsPage(admin, { status: 'draft', limit: 10 })
  assert.equal(draftsOnly.items.length, 3)
  assert.ok(draftsOnly.items.every((entry) => entry.status === 'draft'))
})

test('template pages filter by kind and map the form adapter shape', () => {
  const user = registerFirm('TemplatePageFirm')
  store.createFormTemplate(user, { name: 'Zeta Form', description: '', sections: [] })
  store.createFormTemplate(user, { name: 'Alpha Form', description: '', sections: [] })
  store.createTemplateAggregate(user, { kind: 'document', name: 'Doc Template', sections: [] })

  const firstPage = store.listTemplateAggregatesPage(user, { kind: 'form', limit: 1 })
  assert.equal(firstPage.items.length, 1)
  assert.equal(firstPage.items[0].name, 'Alpha Form')
  assert.ok(firstPage.nextCursor)
  const secondPage = store.listTemplateAggregatesPage(user, { kind: 'form', limit: 1, cursor: firstPage.nextCursor })
  assert.equal(secondPage.items[0].name, 'Zeta Form')
  assert.equal(secondPage.nextCursor, null)

  const documents = store.listTemplateAggregatesPage(user, { kind: 'document', limit: 10 })
  assert.deepEqual(
    documents.items.map((entry) => entry.name),
    ['Doc Template']
  )

  // The paged form-template variant maps the same adapter item shape as the
  // legacy listFormTemplates (sections array present, no raw aggregate keys).
  const formsPage = store.listFormTemplatesPage(user, { limit: 10 })
  assert.equal(formsPage.items.length, 2)
  assert.ok(Array.isArray(formsPage.items[0].sections))
})
