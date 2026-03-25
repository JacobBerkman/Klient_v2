import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function importSourceModule() {
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/modules/profiles/source.mjs')).href +
    `?t=${Date.now()}-${Math.random()}`
  return import(moduleUrl)
}


async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profile-source-store-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-profile-source'
    const moduleUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

test('parseLegacyProfileSource handles spacing and validates malformed legacy values', async () => {
  const { parseLegacyProfileSource } = await importSourceModule()

  assert.deepEqual(parseLegacyProfileSource(' Austin X Seminar X 2026-03-10 '), {
    sourceCity: 'Austin',
    sourceVenue: 'Seminar',
    sourceDate: '2026-03-10',
    campaignId: null
  })

  assert.throws(() => parseLegacyProfileSource('Austin X Seminar'), /Legacy profile source must match/)
  assert.throws(() => parseLegacyProfileSource('Austin X Seminar X 2026-13-40'), /valid calendar date/)
})

test('formatProfileSourceDisplay round-trips with normalizeProfileSource', async () => {
  const { formatProfileSourceDisplay, normalizeProfileSource } = await importSourceModule()

  const normalized = normalizeProfileSource({
    sourceCity: 'Dallas',
    sourceVenue: 'Referral',
    sourceDate: '2026-03-01',
    campaignId: 'spring-2026'
  })

  assert.equal(normalized.displayValue, 'Dallas X Referral X 2026-03-01')
  assert.equal(formatProfileSourceDisplay(normalized), normalized.displayValue)

  const fromLegacy = normalizeProfileSource('Dallas X Referral X 2026-03-01')
  assert.equal(fromLegacy.displayValue, normalized.displayValue)
  assert.equal(fromLegacy.campaignId, null)
})

test('create/update profile validates structured source and derives displayValue', async () => {
  const store = await loadStore()
  const session = store.register({
    firmName: 'Source Validation LLC',
    firstName: 'Terry',
    lastName: 'Advisor',
    email: `source-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'SourceSecure123!'
  })
  const user = store.requireUser(session.token)

  const created = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Edge',
    lastName: 'Case',
    source: {
      sourceCity: 'Houston',
      sourceVenue: 'Workshop',
      sourceDate: '2026-02-02',
      campaignId: 'q1-campaign'
    }
  })

  assert.equal(created.source.displayValue, 'Houston X Workshop X 2026-02-02')
  assert.equal(created.source.campaignId, 'q1-campaign')

  const updated = store.updateProfile(user, created.id, {
    source: { sourceCity: 'Austin', sourceVenue: 'Referral', sourceDate: '2026-02-05' }
  })
  assert.equal(updated.source.displayValue, 'Austin X Referral X 2026-02-05')
  assert.equal(updated.source.campaignId, null)

  assert.throws(
    () =>
      store.updateProfile(user, created.id, {
        source: { sourceCity: 'Austin', sourceVenue: 'Referral', sourceDate: '02-05-2026' }
      }),
    /YYYY-MM-DD/
  )
})


test('migrateProfileSource upgrades legacy object and string values', async () => {
  const { migrateProfileSource } = await importSourceModule()

  const legacyObject = { source: { cityOrLocation: 'Dallas', venue: 'Seminar', occurredOn: '2026-01-10' } }
  const legacyString = { source: 'Austin X Referral X 2026-01-11' }

  migrateProfileSource(legacyObject)
  migrateProfileSource(legacyString)

  assert.deepEqual(legacyObject.source, {
    sourceCity: 'Dallas',
    sourceVenue: 'Seminar',
    sourceDate: '2026-01-10',
    campaignId: null,
    displayValue: 'Dallas X Seminar X 2026-01-10'
  })
  assert.deepEqual(legacyString.source, {
    sourceCity: 'Austin',
    sourceVenue: 'Referral',
    sourceDate: '2026-01-11',
    campaignId: null,
    displayValue: 'Austin X Referral X 2026-01-11'
  })
})
