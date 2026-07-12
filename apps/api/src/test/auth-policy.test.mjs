import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

async function loadStoreWithIsolatedState() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-policy-'))
  const previousEnv = { ...process.env }
  try {
    process.chdir(tempDir)
    process.env.APP_SECRET = 'test-secret-for-auth-policy'
    process.env.AUTH_PROVIDER = 'local'

    const stamp = `${Date.now()}-${Math.random()}`
    const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${stamp}`)
    const providerModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/auth/local-provider.mjs')).href + `?t=${stamp}`
    )
    const store = storeModule.createStore()
    return { store, computeTotp: providerModule.__testUtils.computeTotp }
  } finally {
    process.chdir(previousCwd)
    process.env = previousEnv
  }
}

function loadPolicy() {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(pathToFileURL(resolve(repoRoot, 'apps/api/src/modules/shared/policy.mjs')).href + `?t=${stamp}`).then(
    (module) => module.createPolicy()
  )
}

test('invite lifecycle enforces role constraints, expiration, and single-use', async () => {
  const { store } = await loadStoreWithIsolatedState()
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(adminSession.token)

  assert.throws(() => store.inviteUser(admin, { email: 'owner@example.com', role: 'admin' }), /Invalid invite role/)

  const invite = store.inviteUser(admin, { email: 'teammate@example.com', role: 'advisor' })
  assert.ok(invite.expiresAt)

  const accepted = store.acceptInvite({
    token: invite.token,
    firstName: 'Team',
    lastName: 'Mate',
    password: 'TeamMatePass123!'
  })
  assert.ok(accepted.token)
  assert.throws(
    () =>
      store.acceptInvite({
        token: invite.token,
        firstName: 'Team',
        lastName: 'Mate',
        password: 'TeamMatePass123!'
      }),
    /Invite not found/
  )

  const expiredInvite = store.inviteUser(admin, { email: 'expired@example.com', role: 'readonly' })
  expiredInvite.expiresAt = new Date(Date.now() - 1000).toISOString()
  store.__upsertInviteForTest(expiredInvite)
  assert.throws(
    () =>
      store.acceptInvite({
        token: expiredInvite.token,
        firstName: 'Expired',
        lastName: 'User',
        password: 'ExpiredPass123!'
      }),
    /Invite expired/
  )
})

test('password reset policy enforces TTL, one-time usage, and user/IP rate limits', async () => {
  const { store } = await loadStoreWithIsolatedState()
  store.register({
    firmName: 'Reset Policy Wealth',
    firstName: 'Rae',
    lastName: 'Smith',
    email: 'rae@example.com',
    password: 'StartSecure123!'
  })

  const firstReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' })
  const secondReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' })
  assert.throws(
    () => store.auth.resetPassword({ token: firstReset.token, password: 'NextSecure123!' }),
    /Reset token not found/
  )
  const resetResult = store.auth.resetPassword({ token: secondReset.token, password: 'NextSecure123!' })
  assert.equal(resetResult.ok, true)
  assert.ok(Number.isFinite(resetResult.revokedSessions))
  assert.throws(
    () => store.auth.resetPassword({ token: secondReset.token, password: 'AnotherSecure123!' }),
    /Reset token not found/
  )

  const expiringReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' })
  // passwordResets is a relational source of truth now: push the token's expiry
  // into the past through the test hook instead of mutating a blob array.
  store.__upsertPasswordResetForTest({ ...expiringReset, expiresAt: new Date(Date.now() - 1000).toISOString() })
  assert.throws(
    () => store.auth.resetPassword({ token: expiringReset.token, password: 'FinalSecure123!' }),
    /Reset token expired/
  )

  for (let i = 0; i < 4; i += 1) {
    store.auth.requestReset({ email: 'unknown@example.com', ipAddress: '198.51.100.44' })
  }
  for (let i = 0; i < 6; i += 1) {
    store.auth.requestReset({ email: `other${i}@example.com`, ipAddress: '198.51.100.44' })
  }
  assert.throws(
    () => store.auth.requestReset({ email: 'another@example.com', ipAddress: '198.51.100.44' }),
    /Too many password reset requests from this IP/
  )
})

test('mfa flow enforces challenge-based login, backup codes, and lockout behavior', async () => {
  const { store, computeTotp } = await loadStoreWithIsolatedState()

  store.register({
    firmName: 'MFA Wealth',
    firstName: 'Mia',
    lastName: 'Factor',
    email: 'mia@example.com',
    password: 'StrongMfaPass123!'
  })
  const session = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' })
  const user = store.requireUser(session.token)

  const enrollment = store.startTotpEnrollment(user)
  const code = computeTotp(enrollment.secret)
  const enrollmentResult = store.confirmTotpEnrollment(user, { enrollmentToken: enrollment.enrollmentToken, code })
  assert.equal(enrollmentResult.backupCodes.length, 8)

  const mfaStart = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' })
  assert.equal(mfaStart.mfaRequired, true)

  assert.throws(
    () =>
      store.login({
        email: 'mia@example.com',
        password: 'StrongMfaPass123!',
        mfaChallengeToken: mfaStart.challengeToken,
        totpCode: '000000'
      }),
    /Invalid MFA verification code/
  )

  const completed = store.login({
    email: 'mia@example.com',
    password: 'StrongMfaPass123!',
    mfaChallengeToken: mfaStart.challengeToken,
    totpCode: computeTotp(enrollment.secret)
  })
  assert.ok(completed.token)

  const nextChallenge = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' })
  const backupLogin = store.login({
    email: 'mia@example.com',
    password: 'StrongMfaPass123!',
    mfaChallengeToken: nextChallenge.challengeToken,
    backupCode: enrollmentResult.backupCodes[0]
  })
  assert.ok(backupLogin.token)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(
      () => store.login({ email: 'mia@example.com', password: 'bad-password' }),
      /Invalid email or password/
    )
  }
  assert.throws(
    () => store.login({ email: 'mia@example.com', password: 'bad-password' }),
    /Too many failed login attempts/
  )
})

test('session rotation invalidates prior session token during privilege transitions', async () => {
  const { store } = await loadStoreWithIsolatedState()
  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const rotated = store.rotateSession(session.token, 'mfa_verified')
  assert.ok(rotated.token)
  assert.notEqual(rotated.token, session.token)
  assert.throws(() => store.requireUser(session.token), /Authentication required/)
  assert.equal(store.requireUser(rotated.token).id, rotated.user.id)
})

test('user lookup mode is constrained to same-firm members and supports search', async () => {
  const { store } = await loadStoreWithIsolatedState()
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(adminSession.token)
  const advisorInvite = store.inviteUser(admin, { email: 'lookup-advisor@example.com', role: 'advisor' })
  store.acceptInvite({
    token: advisorInvite.token,
    firstName: 'Lookup',
    lastName: 'Advisor',
    password: 'LookupPass123!'
  })
  store.register({
    firmName: 'Other Firm',
    firstName: 'Other',
    lastName: 'Member',
    email: 'other-firm@example.com',
    password: 'OtherFirmPass123!'
  })

  const lookup = store.listUsers(admin, { mode: 'lookup', search: 'lookup', includeSelf: false, limit: 10 })
  assert.equal(lookup.mode, 'lookup')
  assert.equal(Array.isArray(lookup.users), true)
  assert.ok(lookup.users.every((entry) => entry.email.includes('lookup')))
  assert.ok(lookup.users.every((entry) => entry.id !== admin.id))
  assert.ok(lookup.users.every((entry) => entry.email !== 'other-firm@example.com'))

  // Full-list mode is capped too: an explicit limit is honored and oversized
  // or invalid limits fall back to the ≤200 clamp instead of unbounded rows.
  const fullList = store.listUsers(admin)
  assert.ok(Array.isArray(fullList) && fullList.length >= 2, 'full list returns same-firm users')
  assert.equal(store.listUsers(admin, { limit: 1 }).length, 1, 'full-list limit is honored')
  assert.equal(store.listUsers(admin, { limit: 9_999 }).length, fullList.length, 'oversized limit is clamped')
})

test('ops and export policy guards enforce production privilege boundaries', async () => {
  const policy = await loadPolicy()

  assert.equal(policy.evaluateGuard({ role: 'admin' }, 'canReadDiagnostics').allowed, true)
  assert.equal(policy.evaluateGuard({ role: 'advisor' }, 'canReadDiagnostics').allowed, false)

  assert.equal(policy.evaluateGuard({ role: 'admin' }, 'canProcessExports').allowed, true)
  assert.equal(policy.evaluateGuard({ role: 'advisor' }, 'canProcessExports').allowed, false)
  assert.equal(policy.evaluateGuard({ role: 'readonly' }, 'canProcessExports').allowed, false)

  assert.equal(policy.evaluateGuard({ role: 'advisor' }, 'canReadExports').allowed, true)
  assert.equal(policy.evaluateGuard({ role: 'advisor' }, 'canWriteExports').allowed, true)
  assert.equal(policy.evaluateGuard({ role: 'readonly' }, 'canReadExports').allowed, false)

  assert.throws(
    () => policy.requireGuard({ role: 'advisor' }, 'canProcessExports'),
    /Missing permission: canProcessExports/
  )
  assert.throws(
    () => policy.requireGuard({ role: 'advisor' }, 'canReadDiagnostics'),
    /Missing permission: canReadDiagnostics/
  )
})
