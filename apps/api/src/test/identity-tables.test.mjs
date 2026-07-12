import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { migrations } from '../migrations/index.mjs'

const repoRoot = process.cwd()

async function loadStorage(tempDir) {
  const previousCwd = process.cwd()
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const storage = await import(moduleUrl)
  process.chdir(previousCwd)
  return storage
}

async function loadStore(tempDir) {
  const previousCwd = process.cwd()
  const previousEnv = { ...process.env }
  process.chdir(tempDir)
  process.env.APP_SECRET = 'test-secret-for-identity-tables'
  process.env.AUTH_PROVIDER = 'local'
  try {
    const stamp = `${Date.now()}-${Math.random()}`
    const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${stamp}`)
    return storeModule.createStore()
  } finally {
    process.chdir(previousCwd)
    process.env = previousEnv
  }
}

// ---------------------------------------------------------------------------
// (a) Repository firm-scoping + cross-tenant isolation
// ---------------------------------------------------------------------------
test('firm/user/household repos enforce firm scoping and cross-tenant misses', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-identity-scope-'))
  const storage = await loadStorage(tempDir)
  try {
    storage.saveState({
      marker: 'seed',
      firms: [],
      users: [],
      households: [],
      profiles: [],
      formTemplates: [],
      documentTemplates: [],
      templateAggregates: [],
      exportJobs: [],
      notes: [],
      auditEvents: []
    })

    storage.upsertFirmRow({ id: 'firm-a', name: 'Alpha Firm', slug: 'alpha-firm' })
    storage.upsertFirmRow({ id: 'firm-b', name: 'Beta Firm', slug: 'beta-firm' })
    storage.upsertUserRow({ id: 'user-a1', firmId: 'firm-a', email: 'a1@alpha.test', role: 'admin' })
    storage.upsertUserRow({ id: 'user-a2', firmId: 'firm-a', email: 'a2@alpha.test', role: 'advisor' })
    storage.upsertUserRow({ id: 'user-b1', firmId: 'firm-b', email: 'b1@beta.test', role: 'admin' })
    storage.upsertHouseholdRow({ id: 'hh-a', firmId: 'firm-a', name: 'Alpha Household' })
    storage.upsertHouseholdRow({ id: 'hh-b', firmId: 'firm-b', name: 'Beta Household' })

    // Firm lookups
    assert.equal(storage.getFirmRow('firm-a').name, 'Alpha Firm')
    assert.equal(storage.getFirmBySlug('beta-firm').id, 'firm-b')
    assert.deepEqual(
      storage.listFirmRows().map((firm) => firm.id),
      ['firm-a', 'firm-b']
    )

    // User firm-scoping
    assert.deepEqual(
      storage.listUsersByFirm('firm-a').map((user) => user.id).sort(),
      ['user-a1', 'user-a2']
    )
    assert.deepEqual(
      storage.listUserRows({ firmId: 'firm-b' }).map((user) => user.id),
      ['user-b1']
    )
    // Email is globally unique for login.
    assert.equal(storage.getUserByEmail('a2@alpha.test').id, 'user-a2')
    assert.equal(storage.getUserByEmail('nobody@nowhere.test'), null)
    assert.equal(storage.getUserRow('user-b1').firmId, 'firm-b')

    // Household cross-tenant miss: a firm-scoped read of another firm's id
    // returns null, exactly like the old in-memory find would surface as a
    // "not found" tenancy error.
    assert.equal(storage.getHouseholdRow('hh-b', { firmId: 'firm-a' }), null)
    assert.equal(storage.getHouseholdRow('hh-b', { firmId: 'firm-b' }).name, 'Beta Household')
    assert.deepEqual(
      storage.listHouseholdRows({ firmId: 'firm-a' }).map((hh) => hh.id),
      ['hh-a']
    )

    // deleteHouseholdRow is firm-scoped: a cross-tenant delete is a no-op.
    assert.equal(storage.deleteHouseholdRow('hh-b', 'firm-a'), false)
    assert.ok(storage.getHouseholdRow('hh-b'))
    assert.equal(storage.deleteHouseholdRow('hh-b', 'firm-b'), true)
    assert.equal(storage.getHouseholdRow('hh-b'), null)
  } finally {
    storage.closeDatabase()
  }
})

// ---------------------------------------------------------------------------
// (b) Migration 009 backfills the three tables and clears the blob arrays
// ---------------------------------------------------------------------------
function createLegacyDatabaseAtV8(tempDir, blob) {
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const db = new DatabaseSync(join(tempDir, 'data', 'app.db'))
  try {
    for (const migration of migrations) {
      if (migration.version > 8) continue
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))").run(
      JSON.stringify(blob)
    )
    // Old derived-projection rows (as the pre-009 saveState would have left
    // them) so the migration's INSERT OR IGNORE is provably idempotent and the
    // canonical payloads survive.
    db.prepare('INSERT INTO firms (id, name, slug, payload) VALUES (?, ?, ?, ?)').run(
      'firm-a',
      'Alpha Firm',
      'alpha-firm',
      JSON.stringify({ id: 'firm-a', name: 'Alpha Firm', slug: 'alpha-firm', stageConfig: { stages: [] } })
    )
    db.prepare('INSERT INTO users (id, firm_id, email, role, payload) VALUES (?, ?, ?, ?, ?)').run(
      'user-a1',
      'firm-a',
      'a1@alpha.test',
      'admin',
      JSON.stringify({
        id: 'user-a1',
        firmId: 'firm-a',
        email: 'a1@alpha.test',
        role: 'admin',
        passwordHash: 'hash-a1',
        mfa: { enabled: true, totpSecret: 'SECRETBYTES', backupCodes: ['aa', 'bb'] }
      })
    )
  } finally {
    db.close()
  }
}

test('migration 009 backfills firms/users/households and clears the blob arrays', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-identity-migration-'))
  const blob = {
    marker: 'legacy-pre-009',
    firms: [
      { id: 'firm-a', name: 'Alpha Firm', slug: 'alpha-firm', stageConfig: { stages: [] } },
      { id: 'firm-b', name: 'Beta Firm', slug: 'beta-firm' }
    ],
    users: [
      {
        id: 'user-a1',
        firmId: 'firm-a',
        email: 'a1@alpha.test',
        role: 'admin',
        passwordHash: 'hash-a1',
        mfa: { enabled: true, totpSecret: 'SECRETBYTES', backupCodes: ['aa', 'bb'] }
      },
      { id: 'user-b1', firmId: 'firm-b', email: 'b1@beta.test', role: 'admin', passwordHash: 'hash-b1' }
    ],
    households: [{ id: 'hh-a', firmId: 'firm-a', name: 'Alpha Household', primaryClientId: 'client-1' }]
  }
  createLegacyDatabaseAtV8(tempDir, blob)

  const storage = await loadStorage(tempDir)
  try {
    // Firms backfilled + firm-scoped.
    assert.deepEqual(
      storage.listFirmRows().map((firm) => firm.id).sort(),
      ['firm-a', 'firm-b']
    )
    // Users backfilled; MFA secret / password hash round-trip byte-exact from
    // the payload (the projection row already present is kept via INSERT OR
    // IGNORE — its payload matches).
    const userA = storage.getUserRow('user-a1')
    assert.equal(userA.passwordHash, 'hash-a1')
    assert.equal(userA.mfa.totpSecret, 'SECRETBYTES')
    assert.deepEqual(userA.mfa.backupCodes, ['aa', 'bb'])
    assert.equal(storage.getUserByEmail('b1@beta.test').firmId, 'firm-b')
    // Households backfilled + firm-scoped.
    assert.equal(storage.getHouseholdRow('hh-a', { firmId: 'firm-a' }).primaryClientId, 'client-1')

    // The blob no longer carries the three arrays.
    const inspect = new DatabaseSync(join(tempDir, 'data', 'app.db'), { readOnly: true })
    try {
      const parsed = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.deepEqual(parsed.firms, [])
      assert.deepEqual(parsed.users, [])
      assert.deepEqual(parsed.households, [])
      assert.equal(parsed.marker, 'legacy-pre-009')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

// ---------------------------------------------------------------------------
// (c) Auth mutation persistence — the MOST important test.
// Every in-place user mutation must be upserted; these assertions read the
// users table back and prove the upsert fired, not just an in-memory mutation.
// ---------------------------------------------------------------------------
test('failed logins persist the incremented counter and lockout to the users table', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-identity-lockout-'))
  const store = await loadStore(tempDir)

  store.register({
    firmName: 'Lockout Wealth',
    firstName: 'Lee',
    lastName: 'Ock',
    email: 'lee@example.com',
    password: 'StrongLockPass123!'
  })

  const readUser = () => store.__listUsersForTest().find((entry) => entry.email === 'lee@example.com')

  // One failed login → counter persisted as 1 (proves the upsert fired).
  assert.throws(
    () => store.login({ email: 'lee@example.com', password: 'wrong-password' }),
    /Invalid email or password/
  )
  assert.equal(readUser().security.failedLoginCount, 1)

  // Four more failures (five total) → lockout window persisted.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.throws(
      () => store.login({ email: 'lee@example.com', password: 'wrong-password' }),
      /Invalid email or password/
    )
  }
  const locked = readUser()
  assert.equal(locked.security.failedLoginCount, 5)
  assert.ok(locked.security.lockoutUntil, 'lockout window must be persisted after five failures')
  assert.ok(new Date(locked.security.lockoutUntil).getTime() > Date.now())
})

test('MFA enrollment persists totpSecret + enabled, and password reset persists the new hash', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-identity-mfa-reset-'))
  const previousCwd = process.cwd()
  const previousEnv = { ...process.env }
  process.chdir(tempDir)
  process.env.APP_SECRET = 'test-secret-for-identity-tables'
  process.env.AUTH_PROVIDER = 'local'
  let store
  let computeTotp
  try {
    const stamp = `${Date.now()}-${Math.random()}`
    const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${stamp}`)
    const providerModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/auth/local-provider.mjs')).href + `?t=${stamp}`
    )
    store = storeModule.createStore()
    computeTotp = providerModule.__testUtils.computeTotp
  } finally {
    process.chdir(previousCwd)
    process.env = previousEnv
  }

  store.register({
    firmName: 'MFA Reset Wealth',
    firstName: 'Mo',
    lastName: 'Fa',
    email: 'mo@example.com',
    password: 'StrongMfaPass123!'
  })
  const readUser = () => store.__listUsersForTest().find((entry) => entry.email === 'mo@example.com')
  const originalHash = readUser().passwordHash

  // MFA enroll → totpSecret + enabled must be persisted to the users table.
  const session = store.login({ email: 'mo@example.com', password: 'StrongMfaPass123!' })
  const user = store.requireUser(session.token)
  const enrollment = store.startTotpEnrollment(user)
  store.confirmTotpEnrollment(user, {
    enrollmentToken: enrollment.enrollmentToken,
    code: computeTotp(enrollment.secret)
  })
  const enrolled = readUser()
  assert.equal(enrolled.mfa.enabled, true)
  assert.equal(enrolled.mfa.totpSecret, enrollment.secret)
  assert.equal(enrolled.mfa.backupCodes.length, 8)

  // Password reset → the new hash must be persisted to the users table.
  const reset = store.auth.requestReset({ email: 'mo@example.com', ipAddress: '192.0.2.9' })
  store.auth.resetPassword({ token: reset.token, password: 'BrandNewPass456!' })
  const afterReset = readUser()
  assert.notEqual(afterReset.passwordHash, originalHash, 'reset must persist a new password hash')
  // The reset also cleared any lockout/counters and the new password logs in.
  assert.equal(afterReset.security.failedLoginCount, 0)
  const relogin = store.login({ email: 'mo@example.com', password: 'BrandNewPass456!' })
  assert.equal(relogin.mfaRequired, true)
})
