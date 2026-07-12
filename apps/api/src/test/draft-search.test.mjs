import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EnvKeyProvider, PiiCryptoService } from '../pii-crypto.mjs'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

// Hermetic env: store.mjs/runtime.mjs hard-fail on the dev fallback secret.
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-draft-search-suite'
process.env.AUTH_PROVIDER = 'local'
process.env.PII_KEY_PROVIDER = 'env'

// Each test boots an isolated store against a temp working-directory-relative
// SQLite db (the suite runs serially), then chdir's back.
async function withStore(fn, { createStoreArgs } = {}) {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-draft-search-'))
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  try {
    const mod = await import(moduleUrl)
    const store = createStoreArgs ? mod.createStore(createStoreArgs) : mod.createStore()
    return await fn(store, mod)
  } finally {
    process.chdir(previousCwd)
  }
}

function registerFirm(store, label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `${label} ${suffix}`,
    firstName: 'Owner',
    lastName: label,
    email: `${label.toLowerCase()}.${suffix}@example.com`,
    password: 'DraftSearchPass123'
  })
  return store.requireUser(registered.token)
}

function seedProfileWithDraft(store, user, input) {
  const profile = store.createProfile(user, {
    kind: input.kind || 'client',
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email || '',
    ssn: input.ssn || '',
    taxId: input.taxId || ''
  })
  const draft = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: input.templateId || 'template-draft-search',
    status: 'draft',
    data: {}
  })
  return { profile, draft }
}

// A real, self-contained PII crypto service we can wrap with a spy/faulty
// decrypt. Both encrypt and decrypt round-trip through the SAME key material.
function makeRealCrypto() {
  const keyProvider = new EnvKeyProvider({
    activeKeyId: 'draft-search-key',
    keyring: { 'draft-search-key': 'draft-search-key-material' }
  })
  return new PiiCryptoService({ keyProvider })
}

test('searchDrafts matches by name, is case-insensitive, and excludes non-draft-holders', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'NameFirm')
    seedProfileWithDraft(store, user, { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@calc.example' })
    // A profile with NO draft must never surface in a resume search.
    store.createProfile(user, { kind: 'client', firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.example' })

    const lower = store.searchDrafts(user, 'ada')
    assert.equal(lower.queryType, 'text')
    assert.equal(lower.matches.length, 1)
    assert.equal(lower.matches[0].name, 'Ada Lovelace')
    assert.equal(lower.matches[0].drafts.length, 1)

    // Case-insensitive on both first and last name.
    assert.equal(store.searchDrafts(user, 'ADA').matches.length, 1)
    assert.equal(store.searchDrafts(user, 'LOVELACE').matches.length, 1)

    // Grace has no draft -> not a match even though the name matches.
    assert.equal(store.searchDrafts(user, 'grace').matches.length, 0)
  })
})

test('searchDrafts matches by email (case-insensitive)', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'EmailFirm')
    seedProfileWithDraft(store, user, { firstName: 'Alan', lastName: 'Turing', email: 'Alan@Bletchley.example' })

    const byEmail = store.searchDrafts(user, 'bletchley.example')
    assert.equal(byEmail.matches.length, 1)
    assert.equal(byEmail.matches[0].email, 'Alan@Bletchley.example')
  })
})

test('searchDrafts matches SSN last-4 via a real encrypted envelope', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'SsnFirm')
    // Seeded through the real write path -> ssn is stored as an encrypted
    // envelope; the search must decrypt it in memory to match the last 4.
    seedProfileWithDraft(store, user, {
      firstName: 'Katherine',
      lastName: 'Johnson',
      email: 'kat@nasa.example',
      ssn: '123-45-6789'
    })

    const bySsn = store.searchDrafts(user, '6789')
    assert.equal(bySsn.queryType, 'ssn4')
    assert.equal(bySsn.ssnSearchAvailable, true)
    assert.equal(bySsn.matches.length, 1)
    assert.equal(bySsn.matches[0].name, 'Katherine Johnson')

    // A non-matching 4-digit query returns nothing.
    assert.equal(store.searchDrafts(user, '0000').matches.length, 0)
    // The echoed query is blanked for SSN4 so the digits are never reflected.
    assert.equal(bySsn.query, '')
  })
})

test('searchDrafts never decrypts for non-4-digit (text) queries', async () => {
  const real = makeRealCrypto()
  let decryptCount = 0
  const spy = {
    encrypt: (value) => real.encrypt(value),
    decrypt: (payload) => {
      decryptCount += 1
      return real.decrypt(payload)
    },
    needsReencryption: (payload) => real.needsReencryption(payload),
    reencrypt: (payload) => real.reencrypt(payload)
  }

  await withStore(
    (store) => {
      const user = registerFirm(store, 'SpyFirm')
      seedProfileWithDraft(store, user, {
        firstName: 'Edsger',
        lastName: 'Dijkstra',
        email: 'ed@algo.example',
        ssn: '987-65-4321'
      })

      // Text query: the ssn4 branch is never entered, so decrypt is untouched.
      store.searchDrafts(user, 'dijkstra')
      store.searchDrafts(user, 'algo.example')
      assert.equal(decryptCount, 0, 'text queries must not trigger any PII decryption')

      // A 4-digit query DOES enter the decrypt branch.
      store.searchDrafts(user, '4321')
      assert.ok(decryptCount > 0, 'ssn4 queries must decrypt to compare last-4')
    },
    { createStoreArgs: { piiCrypto: spy } }
  )
})

test('searchDrafts is firm-scoped: foreign-firm drafts are invisible', async () => {
  await withStore((store) => {
    const firmA = registerFirm(store, 'FirmA')
    const firmB = registerFirm(store, 'FirmB')
    seedProfileWithDraft(store, firmB, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@firmb.example',
      ssn: '123-45-6789'
    })

    // Firm A sees nothing: neither name nor SSN4 crosses the tenant boundary.
    assert.equal(store.searchDrafts(firmA, 'ada').matches.length, 0)
    assert.equal(store.searchDrafts(firmA, '6789').matches.length, 0)
  })
})

test('searchDrafts excludes archived profiles', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'ArchiveFirm')
    const { profile } = seedProfileWithDraft(store, user, {
      firstName: 'Barbara',
      lastName: 'Liskov',
      email: 'barbara@types.example',
      ssn: '111-22-3333'
    })

    assert.equal(store.searchDrafts(user, 'liskov').matches.length, 1)

    store.archiveProfile(user, profile.id)

    assert.equal(store.searchDrafts(user, 'liskov').matches.length, 0)
    assert.equal(store.searchDrafts(user, '3333').matches.length, 0)
  })
})

test('searchDrafts audits every search with queryType and without the SSN4 digits', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'AuditFirm')
    seedProfileWithDraft(store, user, {
      firstName: 'Radia',
      lastName: 'Perlman',
      email: 'radia@spanningtree.example',
      ssn: '555-44-6789'
    })

    store.searchDrafts(user, 'perlman')
    store.searchDrafts(user, '6789')

    const events = store.listAudit(user).filter((entry) => entry.action === 'drafts.searched')
    assert.equal(events.length, 2, 'each search writes exactly one audit event')

    // Newest-first ordering: the ssn4 search is [0], the text search is [1].
    const ssnEvent = events.find((entry) => entry.after?.queryType === 'ssn4')
    const textEvent = events.find((entry) => entry.after?.queryType === 'text')
    assert.ok(ssnEvent, 'ssn4 search must be audited')
    assert.ok(textEvent, 'text search must be audited')

    // The plaintext text query IS logged.
    assert.equal(textEvent.after.query, 'perlman')
    assert.equal(typeof textEvent.after.matches, 'number')

    // The SSN4 query string is NEVER persisted anywhere on the event.
    assert.equal(ssnEvent.after.query, undefined)
    assert.ok(
      !JSON.stringify(ssnEvent).includes('6789'),
      'the SSN last-4 digits must not appear anywhere in the audit event'
    )
    assert.equal(typeof ssnEvent.after.matches, 'number')
  })
})

test('searchDrafts degrades gracefully to name/email-only when the PII key is unavailable', async () => {
  const real = makeRealCrypto()
  const faulty = {
    // Encrypt still works (seeding writes a real envelope) ...
    encrypt: (value) => real.encrypt(value),
    // ... but the key can no longer be resolved at query time.
    decrypt: () => {
      throw new Error('Unable to resolve PII key: draft-search-key.')
    },
    needsReencryption: () => false,
    reencrypt: (payload) => payload
  }

  await withStore(
    (store) => {
      const user = registerFirm(store, 'DegradedFirm')
      seedProfileWithDraft(store, user, {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@compiler.example',
        ssn: '123-45-6789'
      })

      // SSN4 search: does not throw, flags SSN search unavailable, and finds
      // nothing on the SSN path.
      const ssn = store.searchDrafts(user, '6789')
      assert.equal(ssn.ssnSearchAvailable, false)
      assert.equal(ssn.matches.length, 0)

      // Name/email search still works fully in degraded mode.
      const byName = store.searchDrafts(user, 'hopper')
      assert.equal(byName.ssnSearchAvailable, true, 'text queries never touch the key, so they are not degraded')
      assert.equal(byName.matches.length, 1)
    },
    { createStoreArgs: { piiCrypto: faulty } }
  )
})

test('searchDrafts denies readonly users (forms:write guard)', async () => {
  await withStore((store) => {
    const user = registerFirm(store, 'GuardFirm')
    seedProfileWithDraft(store, user, { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@calc.example' })

    const readonlyUser = { ...user, role: 'readonly' }
    assert.throws(() => store.searchDrafts(readonlyUser, 'ada'), /Missing permission: forms:write/)
  })
})
