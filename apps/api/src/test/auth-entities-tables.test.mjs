import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

const LOGIN_WINDOW_MS = 1000 * 60 * 15
const RESET_RATE_WINDOW_MS = 1000 * 60 * 60

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString()
}

function loginCutoff() {
  return isoAgo(LOGIN_WINDOW_MS)
}

function resetCutoff() {
  return isoAgo(RESET_RATE_WINDOW_MS)
}

// Loads a fresh storage module bound to an isolated on-disk database (migrations
// run to the latest version at import). The db handle is bound to the temp cwd
// at import time, so we can restore cwd immediately afterwards.
async function loadStorage() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-entities-'))
  try {
    process.chdir(tempDir)
    const stamp = `${Date.now()}-${Math.random()}`
    const storage = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${stamp}`)
    return storage
  } finally {
    process.chdir(previousCwd)
  }
}

// Mirrors the auth-policy harness: loads a store bound to an isolated database
// with the dev env the app expects.
async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-entities-store-'))
  const previousEnv = { ...process.env }
  try {
    process.chdir(tempDir)
    process.env.APP_SECRET = 'test-secret-for-auth-entities'
    process.env.AUTH_PROVIDER = 'local'
    const stamp = `${Date.now()}-${Math.random()}`
    const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${stamp}`)
    const providerModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/auth/local-provider.mjs')).href + `?t=${stamp}`
    )
    return { store: storeModule.createStore(), computeTotp: providerModule.__testUtils.computeTotp }
  } finally {
    process.chdir(previousCwd)
    process.env = previousEnv
  }
}

test('auth_attempts: login lockout counts trigger at exactly 5 email / 25 IP failures within the window', async () => {
  const storage = await loadStorage()

  // Four failures for one email are under the per-email limit (5).
  for (let i = 0; i < 4; i += 1) {
    storage.insertAuthAttempt({ email: 'lockme@example.com', ipAddress: '198.51.100.7', ok: false, createdAt: new Date().toISOString() })
  }
  assert.equal(storage.countFailedLoginsByEmail('lockme@example.com', loginCutoff()), 4)

  // The fifth failure reaches the per-email lockout threshold (>= 5).
  storage.insertAuthAttempt({ email: 'lockme@example.com', ipAddress: '198.51.100.7', ok: false, createdAt: new Date().toISOString() })
  assert.equal(storage.countFailedLoginsByEmail('lockme@example.com', loginCutoff()), 5)

  // Successful-login clears every attempt for the email (deleteAuthAttemptsByEmail),
  // resetting the counter to zero.
  storage.deleteAuthAttemptsByEmail('lockme@example.com')
  assert.equal(storage.countFailedLoginsByEmail('lockme@example.com', loginCutoff()), 0)

  // Per-IP threshold is 25: spread across distinct emails so no email locks out.
  for (let i = 0; i < 25; i += 1) {
    storage.insertAuthAttempt({ email: `ipuser${i}@example.com`, ipAddress: '203.0.113.42', ok: false, createdAt: new Date().toISOString() })
  }
  assert.equal(storage.countFailedLoginsByIp('203.0.113.42', loginCutoff()), 25)

  // Successful (ok = 1) attempts never count toward the failure limit.
  storage.insertAuthAttempt({ email: 'ok@example.com', ipAddress: '203.0.113.99', ok: true, createdAt: new Date().toISOString() })
  assert.equal(storage.countFailedLoginsByEmail('ok@example.com', loginCutoff()), 0)
  assert.equal(storage.countFailedLoginsByIp('203.0.113.99', loginCutoff()), 0)

  storage.closeDatabase()
})

test('auth_attempts: failures older than the 15-minute window are not counted', async () => {
  const storage = await loadStorage()

  // A failure stamped 20 minutes ago is outside the 15-minute window.
  storage.insertAuthAttempt({ email: 'stale@example.com', ipAddress: '192.0.2.50', ok: false, createdAt: isoAgo(1000 * 60 * 20) })
  assert.equal(storage.countFailedLoginsByEmail('stale@example.com', loginCutoff()), 0)
  assert.equal(storage.countFailedLoginsByIp('192.0.2.50', loginCutoff()), 0)

  // A fresh failure inside the window does count.
  storage.insertAuthAttempt({ email: 'stale@example.com', ipAddress: '192.0.2.50', ok: false, createdAt: new Date().toISOString() })
  assert.equal(storage.countFailedLoginsByEmail('stale@example.com', loginCutoff()), 1)

  // deleteExpiredAuthAttempts removes the stale row and keeps the fresh one.
  storage.deleteExpiredAuthAttempts(loginCutoff())
  assert.equal(storage.countFailedLoginsByEmail('stale@example.com', loginCutoff()), 1)

  storage.closeDatabase()
})

test('password_reset_attempts: rate limits trigger at 5 per user and 10 per IP within the hour window', async () => {
  const storage = await loadStorage()

  for (let i = 0; i < 5; i += 1) {
    storage.insertPasswordResetAttempt({ email: 'rl@example.com', ipAddress: '198.51.100.1', createdAt: new Date().toISOString() })
  }
  assert.equal(storage.countResetAttemptsByEmail('rl@example.com', resetCutoff()), 5)

  // Per-IP threshold is 10: use distinct emails so no per-user limit interferes.
  for (let i = 0; i < 10; i += 1) {
    storage.insertPasswordResetAttempt({ email: `rluser${i}@example.com`, ipAddress: '203.0.113.10', createdAt: new Date().toISOString() })
  }
  assert.equal(storage.countResetAttemptsByIp('203.0.113.10', resetCutoff()), 10)

  // Attempts older than the one-hour window drop out of the count.
  storage.insertPasswordResetAttempt({ email: 'old@example.com', ipAddress: '203.0.113.20', createdAt: isoAgo(1000 * 60 * 90) })
  assert.equal(storage.countResetAttemptsByEmail('old@example.com', resetCutoff()), 0)

  storage.closeDatabase()
})

test('password_resets: find, expire-consume, and per-user revocation', async () => {
  const storage = await loadStorage()

  const active = {
    id: 'reset-active',
    userId: 'user-1',
    token: 'token-active',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString()
  }
  storage.insertPasswordReset(active)

  const found = storage.findPasswordResetByToken('token-active')
  assert.ok(found)
  assert.equal(found.userId, 'user-1')
  assert.equal(found.token, 'token-active')
  assert.equal(storage.findPasswordResetByToken('does-not-exist'), null)

  // Expired-token consume path: delete by id.
  assert.equal(storage.deletePasswordResetById('reset-active'), 1)
  assert.equal(storage.findPasswordResetByToken('token-active'), null)

  // Requesting a new token deletes existing tokens for the user first (one
  // active token per user).
  storage.insertPasswordReset({ id: 'reset-a', userId: 'user-2', token: 'tok-a', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() })
  storage.deletePasswordResetsByUser('user-2')
  storage.insertPasswordReset({ id: 'reset-b', userId: 'user-2', token: 'tok-b', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() })
  assert.equal(storage.findPasswordResetByToken('tok-a'), null)
  assert.ok(storage.findPasswordResetByToken('tok-b'))

  storage.closeDatabase()
})

test('mfa_challenges: find-by-token+user, expiry rejection, and consume-by-id', async () => {
  const storage = await loadStorage()

  const challenge = {
    id: 'chal-1',
    token: 'chal-token',
    userId: 'user-9',
    method: 'totp',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString()
  }
  storage.insertMfaChallenge(challenge)

  // Scoped find requires both token AND user.
  const found = storage.findMfaChallengeByTokenAndUser('chal-token', 'user-9')
  assert.ok(found)
  assert.equal(found.id, 'chal-1')
  assert.equal(storage.findMfaChallengeByTokenAndUser('chal-token', 'someone-else'), null)

  // An expired challenge is still returned by the lookup — the caller compares
  // expiresAt against now and rejects it.
  storage.insertMfaChallenge({ id: 'chal-2', token: 'expired-token', userId: 'user-9', method: 'totp', createdAt: isoAgo(1000 * 60 * 20), expiresAt: isoAgo(1000 * 60 * 10) })
  const expired = storage.findMfaChallengeByTokenAndUser('expired-token', 'user-9')
  assert.ok(expired)
  assert.ok(new Date(expired.expiresAt).getTime() <= Date.now())

  // Consume by id.
  assert.equal(storage.deleteMfaChallengeById('chal-1'), 1)
  assert.equal(storage.findMfaChallengeByTokenAndUser('chal-token', 'user-9'), null)

  // Per-user revocation (used by resetPassword) clears all of a user's challenges.
  assert.equal(storage.deleteMfaChallengesByUser('user-9'), 1)
  assert.equal(storage.findMfaChallengeByTokenAndUser('expired-token', 'user-9'), null)

  storage.closeDatabase()
})

test('resetPassword consumes the reset token and clears the user pending MFA challenges', async () => {
  const { store, computeTotp } = await loadStore()

  store.register({
    firmName: 'Reset Clears Mfa Wealth',
    firstName: 'Cara',
    lastName: 'Reset',
    email: 'reset-mfa@example.com',
    password: 'StartSecure123!'
  })
  const session = store.login({ email: 'reset-mfa@example.com', password: 'StartSecure123!' })
  const user = store.requireUser(session.token)

  const enrollment = store.startTotpEnrollment(user)
  store.confirmTotpEnrollment(user, { enrollmentToken: enrollment.enrollmentToken, code: computeTotp(enrollment.secret) })

  // Create a pending MFA challenge, then reset the password.
  const challenge = store.auth.createMfaChallenge(user)
  const reset = store.auth.requestReset({ email: 'reset-mfa@example.com', ipAddress: '203.0.113.5' })
  const result = store.auth.resetPassword({ token: reset.token, password: 'NextSecure123!' })
  assert.equal(result.ok, true)

  // The reset token is single-use.
  assert.throws(
    () => store.auth.resetPassword({ token: reset.token, password: 'AnotherSecure123!' }),
    /Reset token not found/
  )

  // The pending challenge was cleared by resetPassword.
  assert.throws(
    () => store.auth.verifyMfaChallenge(user, { challengeToken: challenge.challengeToken, totpCode: computeTotp(enrollment.secret) }),
    /MFA challenge expired or not found/
  )
})

test('migration 008 backfills the four auth tables and clears the blob arrays', async () => {
  const { default: migration } = await import(
    pathToFileURL(resolve(repoRoot, 'apps/api/src/migrations/008-auth-entities.mjs')).href
  )
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-mig-'))
  const db = new DatabaseSync(join(tempDir, 'mig.db'))
  try {
    db.exec('CREATE TABLE app_state (id INTEGER PRIMARY KEY, payload TEXT, updated_at TEXT)')
    const blob = {
      authAttempts: [{ id: 'aa1', email: 'x@y.z', ipAddress: '1.1.1.1', ok: false, createdAt: '2020-01-01T00:00:00.000Z' }],
      passwordResetAttempts: [{ id: 'pra1', email: 'x@y.z', ipAddress: '1.1.1.1', createdAt: '2020-01-01T00:00:00.000Z' }],
      passwordResets: [{ id: 'pr1', userId: 'u1', token: 'reset-tok', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:30:00.000Z' }],
      mfaChallenges: [{ id: 'mc1', token: 'mfa-tok', userId: 'u1', method: 'totp', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' }],
      other: [{ keep: true }]
    }
    db.prepare('INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(blob), 'now')

    migration.up(db)

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM auth_attempts').get().c, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM password_reset_attempts').get().c, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM password_resets').get().c, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mfa_challenges').get().c, 1)
    assert.equal(db.prepare('SELECT ok FROM auth_attempts WHERE id = ?').get('aa1').ok, 0)
    assert.equal(db.prepare('SELECT token FROM password_resets WHERE id = ?').get('pr1').token, 'reset-tok')

    const cleared = JSON.parse(db.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
    assert.deepEqual(cleared.authAttempts, [])
    assert.deepEqual(cleared.passwordResetAttempts, [])
    assert.deepEqual(cleared.passwordResets, [])
    assert.deepEqual(cleared.mfaChallenges, [])
    // Unrelated blob keys are left untouched.
    assert.deepEqual(cleared.other, [{ keep: true }])

    // Idempotent: re-running does not duplicate rows.
    migration.up(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM auth_attempts').get().c, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mfa_challenges').get().c, 1)
  } finally {
    db.close()
  }
})
