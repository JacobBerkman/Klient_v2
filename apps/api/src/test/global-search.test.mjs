import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPolicy } from '../modules/shared/policy.mjs'
import { createSearchService } from '../modules/search/service.mjs'

// Hermetic env: store.mjs/runtime.mjs hard-fail on the dev fallback secret.
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-global-search-suite'
process.env.AUTH_PROVIDER = 'local'
process.env.PII_KEY_PROVIDER = 'env'

// storage.mjs binds its SQLite file to process.cwd() at import time, so chdir
// into an isolated temp dir BEFORE the first import (loadStorage(tempDir)
// convention). The suite shares one database; tests isolate per registered
// firm.
const tempDir = mkdtempSync(join(tmpdir(), 'klient-global-search-'))
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
    password: 'GlobalSearchPass123'
  })
  return store.requireUser(registered.token)
}

function resultsFor(user, q, options = {}) {
  return store.searchGlobal(user, { q, ...options }).results
}

test('search_index pins the promoted plaintext column set (never payload)', () => {
  assert.deepEqual(storage.getSearchIndexColumnsForTest(), ['title', 'subtitle', 'firm_id', 'entity_type', 'entity_id'])
})

test('global search is firm-scoped', () => {
  const firmA = registerFirm('IsolationA')
  const firmB = registerFirm('IsolationB')
  const profile = store.createProfile(firmA, {
    kind: 'client',
    firstName: 'Zelda',
    lastName: 'Searchson',
    email: 'zelda@firma.example'
  })

  const mine = resultsFor(firmA, 'zelda')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].type, 'profile')
  assert.equal(mine[0].id, profile.id)
  assert.equal(mine[0].title, 'Zelda Searchson')

  assert.equal(resultsFor(firmB, 'zelda').length, 0, 'foreign firm must never see the profile')
})

test('encrypted PII never enters the index and is not searchable', () => {
  const user = registerFirm('PiiFirm')
  store.createProfile(user, {
    kind: 'client',
    firstName: 'Katherine',
    lastName: 'Johnson',
    email: 'kat@nasa.example',
    ssn: '987-65-4321',
    dateOfBirth: '1918-08-26'
  })

  // Searching the SSN digits (full or last-4) returns nothing.
  assert.equal(resultsFor(user, '4321').length, 0)
  assert.equal(resultsFor(user, '987654321').length, 0)
  assert.equal(resultsFor(user, '987-65-4321').length, 0)

  // And the raw index rows never contain the digits or the DOB: only the
  // promoted plaintext columns (name/email/phone, household/template names)
  // are ever written by the triggers.
  const dump = JSON.stringify(storage.listSearchIndexEntriesForTest())
  assert.ok(!dump.includes('4321'), 'SSN digits must not appear anywhere in the search index')
  assert.ok(!dump.includes('1918-08-26'), 'DOB must not appear anywhere in the search index')

  // The profile itself IS findable by its indexed columns.
  const byName = resultsFor(user, 'katherine johnson')
  assert.equal(byName.length, 1)
  assert.equal(byName[0].subtitle.includes('kat@nasa.example'), true)
})

test('triggers keep the index in sync on update, archive, restore, and delete', () => {
  const user = registerFirm('TriggerFirm')
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Trigger',
    lastName: 'Subject',
    email: 'subject@sync.example'
  })
  assert.equal(resultsFor(user, 'trigger').length, 1)

  // Update: the renamed profile is findable under the new name only.
  store.updateProfile(user, profile.id, { firstName: 'Renata' })
  assert.equal(resultsFor(user, 'renata').length, 1)
  assert.equal(
    resultsFor(user, 'trigger').filter((entry) => entry.id === profile.id).length,
    0,
    'old first name must no longer match after rename'
  )

  // Archive: drops out of the index entirely.
  store.archiveProfile(user, profile.id)
  assert.equal(resultsFor(user, 'renata').length, 0)
  assert.equal(
    storage.listSearchIndexEntriesForTest().filter((row) => row.entityId === profile.id).length,
    0,
    'archived profile must have no index rows'
  )

  // Restore: comes back.
  store.restoreProfile(user, profile.id)
  assert.equal(resultsFor(user, 'renata').length, 1)

  // Households: archive drops, hard delete drops.
  const primary = store.createProfile(user, {
    kind: 'client',
    firstName: 'House',
    lastName: 'Primary',
    email: 'primary@sync.example'
  })
  const household = store.createHousehold(user, { name: 'Sync Household', primaryClientId: primary.id })
  assert.equal(
    resultsFor(user, 'sync household').some((entry) => entry.type === 'household'),
    true
  )
  store.archiveHousehold(user, household.id)
  assert.equal(
    resultsFor(user, 'sync household').some((entry) => entry.type === 'household'),
    false
  )
  store.restoreHousehold(user, household.id)
  storage.deleteHouseholdRow(household.id, user.firmId)
  assert.equal(
    resultsFor(user, 'sync household').some((entry) => entry.type === 'household'),
    false
  )
})

test('templates are indexed by name and deduped across projection tables', () => {
  const user = registerFirm('TemplateFirm')
  const template = store.createFormTemplate(user, { name: 'Alpha Intake Packet', description: '', sections: [] })

  // The aggregate row AND the form_templates projection row are both indexed;
  // the query dedupes them into a single navigable template result.
  const results = resultsFor(user, 'alpha intake')
  const templates = results.filter((entry) => entry.type === 'template')
  assert.equal(templates.length, 1)
  assert.equal(templates[0].id, template.id)
  assert.equal(templates[0].subtitle, 'Form template')
})

test('submissions resolve at query time and respect draft collaborator visibility', () => {
  const admin = registerFirm('SubmissionFirm')
  const client = store.createProfile(admin, {
    kind: 'client',
    firstName: 'Querulous',
    lastName: 'Submitter',
    email: 'querulous@sub.example'
  })
  const template = store.createFormTemplate(admin, { name: 'Submission Search Form', description: '', sections: [] })
  const draft = store.createFormSubmission(admin, {
    clientId: client.id,
    templateId: template.id,
    status: 'draft',
    data: {}
  })
  const submitted = store.createFormSubmission(admin, {
    clientId: client.id,
    templateId: template.id,
    status: 'submitted',
    data: {}
  })

  // Creator sees both the draft and the submitted record via the matched profile.
  const adminResults = resultsFor(admin, 'querulous', { types: ['submission'] })
  assert.deepEqual(
    adminResults
      .filter((entry) => entry.type === 'submission')
      .map((entry) => entry.id)
      .sort(),
    [draft.id, submitted.id].sort()
  )
  assert.ok(
    adminResults.every((entry) => entry.type === 'submission'),
    'types=submission must not emit profile results'
  )
  // Titles come from promoted columns only (template + client names).
  assert.ok(adminResults[0].title.includes('Submission Search Form'))

  // A non-collaborator advisor in the same firm sees only the submitted record.
  const outsider = { id: `user-${randomUUID()}`, firmId: admin.firmId, role: 'advisor' }
  const outsiderResults = resultsFor(outsider, 'querulous', { types: ['submission'] })
  assert.deepEqual(
    outsiderResults.map((entry) => entry.id),
    [submitted.id]
  )
})

test('LIKE fallback (no FTS5) returns the same results and stays trigger-synced', () => {
  const user = registerFirm('FallbackFirm')
  store.createProfile(user, {
    kind: 'client',
    firstName: 'Fallback',
    lastName: 'Candidate',
    email: 'fallback@like.example'
  })
  const primary = store.createProfile(user, {
    kind: 'client',
    firstName: 'Fallback',
    lastName: 'Primary',
    email: 'fbprimary@like.example'
  })
  store.createHousehold(user, { name: 'Fallback Household', primaryClientId: primary.id })

  assert.equal(storage.getSearchIndexMode(), 'fts5')
  const queries = ['fallback', 'fallback@like.example', 'fallback household']
  const ftsResults = queries.map((q) =>
    resultsFor(user, q)
      .map((entry) => `${entry.type}:${entry.id}`)
      .sort()
  )

  // Rebuild the index as a plain table (simulating an SQLite build without
  // FTS5) and verify parity for the same queries.
  storage.__dropSearchIndexForTest()
  const rebuilt = storage.ensureSearchIndex({ forceLikeMode: true })
  assert.deepEqual(rebuilt, { mode: 'like', rebuilt: true })
  assert.equal(storage.getSearchIndexMode(), 'like')

  const likeResults = queries.map((q) =>
    resultsFor(user, q)
      .map((entry) => `${entry.type}:${entry.id}`)
      .sort()
  )
  assert.deepEqual(likeResults, ftsResults, 'LIKE fallback must return the same result sets')

  // The sync triggers keep working against the plain table.
  store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Postfallback',
    lastName: 'Prospect',
    email: 'post@like.example'
  })
  assert.equal(resultsFor(user, 'postfallback').length, 1)
})

test('client role is denied by the canUseGlobalSearch guard; readonly is allowed', () => {
  const admin = registerFirm('GuardFirm')
  store.createProfile(admin, {
    kind: 'client',
    firstName: 'Guarded',
    lastName: 'Record',
    email: 'guarded@x.example'
  })
  const policy = createPolicy()
  const service = createSearchService({ store, policy })

  const clientUser = { id: 'client-1', firmId: admin.firmId, role: 'client' }
  assert.throws(() => service.search(clientUser, { q: 'guarded' }), /Missing permission: canUseGlobalSearch/)

  const readonlyUser = { id: 'readonly-1', firmId: admin.firmId, role: 'readonly' }
  const payload = service.search(readonlyUser, { q: 'guarded' })
  assert.equal(payload.results.length, 1)
  assert.equal(payload.results[0].title, 'Guarded Record')

  // Anonymous is denied too.
  assert.throws(() => service.search(null, { q: 'guarded' }), /Missing permission: canUseGlobalSearch/)
})
