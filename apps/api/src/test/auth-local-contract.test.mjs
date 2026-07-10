import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

function loadStoreWithIsolatedState() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-contract-'))
  process.chdir(tempDir)
  process.env.APP_SECRET = 'test-secret-for-auth-contract'
  process.env.AUTH_PROVIDER = 'local'
  const moduleUrl =
    pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  return import(moduleUrl).then((mod) => {
    const store = mod.createStore()
    process.chdir(previousCwd)
    return store
  })
}

test('local provider contract supports register/login and lockout behavior', async () => {
  const store = await loadStoreWithIsolatedState()

  assert.throws(
    () =>
      store.auth.register({
        firmName: 'Weak Password Wealth',
        firstName: 'Casey',
        lastName: 'Jones',
        email: 'casey@example.com',
        password: 'weakpass'
      }),
    /Password must/
  )

  const registration = store.auth.register({
    firmName: 'Secure Wealth',
    firstName: 'Alex',
    lastName: 'Stone',
    email: 'alex@example.com',
    password: 'SecurePass123!'
  })

  assert.equal(store.requireUser(registration.token).email, 'alex@example.com')

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(
      () => store.auth.login({ email: 'alex@example.com', password: 'invalid', ipAddress: '203.0.113.1' }),
      /Invalid email or password/
    )
  }

  assert.throws(
    () => store.auth.login({ email: 'alex@example.com', password: 'invalid', ipAddress: '203.0.113.1' }),
    /Too many failed login attempts|Account is temporarily locked/
  )
})

test('local provider contract supports invite acceptance', async () => {
  const store = await loadStoreWithIsolatedState()
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(adminSession.token)

  const invite = store.inviteUser(admin, { email: 'new.user@example.com', role: 'advisor' })
  const accepted = store.auth.acceptInvite({
    token: invite.token,
    firstName: 'New',
    lastName: 'User',
    password: 'InviteSecure123!'
  })

  assert.ok(accepted.token)
  assert.equal(store.requireUser(accepted.token).email, 'new.user@example.com')

  assert.throws(
    () =>
      store.auth.acceptInvite({
        token: invite.token,
        firstName: 'New',
        lastName: 'User',
        password: 'InviteSecure123!'
      }),
    /Invite not found/
  )
})

test('local provider contract enforces password reset and revokes active sessions', async () => {
  const store = await loadStoreWithIsolatedState()

  store.auth.register({
    firmName: 'Reset Partners',
    firstName: 'Jordan',
    lastName: 'Reed',
    email: 'jordan@example.com',
    password: 'AnotherSecure123!'
  })

  const sessionA = store.auth.login({ email: 'jordan@example.com', password: 'AnotherSecure123!' })
  const sessionB = store.auth.login({ email: 'jordan@example.com', password: 'AnotherSecure123!' })
  assert.ok(sessionA.token)
  assert.ok(sessionB.token)

  const reset = store.auth.requestReset({ email: 'jordan@example.com', ipAddress: '198.51.100.2' })
  assert.ok(reset.token)

  assert.throws(() => store.auth.resetPassword({ token: reset.token, password: 'weak' }), /Password must/)

  const result = store.auth.resetPassword({ token: reset.token, password: 'ResetSecure123!' })
  assert.equal(result.ok, true)
  assert.ok(result.revokedSessions >= 2)

  assert.throws(() => store.requireUser(sessionA.token), /Authentication required/)
  const login = store.auth.login({ email: 'jordan@example.com', password: 'ResetSecure123!' })
  assert.equal(store.requireUser(login.token).email, 'jordan@example.com')
})

test('legacy store auth aliases remain backward-compatible', async () => {
  const store = await loadStoreWithIsolatedState()

  const registration = store.register({
    firmName: 'Alias Advisory',
    firstName: 'Morgan',
    lastName: 'Bates',
    email: 'morgan@example.com',
    password: 'AliasSecure123!'
  })

  assert.ok(registration.token)
  const reset = store.requestPasswordReset('morgan@example.com')
  assert.ok(reset.token)

  const resetResult = store.resetPassword({ token: reset.token, password: 'AliasReset123!' })
  assert.equal(resetResult.ok, true)
  const session = store.login({ email: 'morgan@example.com', password: 'AliasReset123!' })
  assert.equal(store.requireUser(session.token).email, 'morgan@example.com')
})

test('firm stage configuration is initialized and backfilled for legacy payloads', async () => {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-stage-config-'))
  process.chdir(tempDir)
  process.env.APP_SECRET = 'test-secret-for-auth-contract'
  process.env.AUTH_PROVIDER = 'local'

  const storeModuleUrl =
    pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  // Deliberately NOT cache-busted: store.mjs's internal `./storage.mjs` import
  // resolves without a query string, so this returns the same module instance
  // (and therefore the same database) the store writes through. A cache-busted
  // import here would open a fresh, empty database in this test's temp dir.
  const storageModuleUrl = pathToFileURL(resolve(previousCwd, 'apps/api/src/storage.mjs')).href
  const storeModule = await import(storeModuleUrl)
  const storageModule = await import(storageModuleUrl)
  const firstStore = storeModule.createStore()

  firstStore.auth.register({
    firmName: 'Stage Config Advisory',
    firstName: 'Jordan',
    lastName: 'Miles',
    email: 'jordan+stage@example.com',
    password: 'StageConfig123!'
  })

  const db = new DatabaseSync(storageModule.DB_PATH)
  const current = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
  const parsed = JSON.parse(current.payload)
  parsed.firms = (parsed.firms || []).map(({ stageConfig, ...firm }) => ({ ...firm }))
  db.prepare('UPDATE app_state SET payload = ?, updated_at = datetime(\'now\') WHERE id = 1').run(JSON.stringify(parsed))
  db.close()

  const reloadedModule =
    pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const secondStore = (await import(reloadedModule)).createStore()
  const restored = new DatabaseSync(storageModule.DB_PATH)
  const backfilled = JSON.parse(restored.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
  restored.close()

  const restoredFirm = backfilled.firms.find((firm) => firm.name === 'Stage Config Advisory')
  assert.ok(restoredFirm?.stageConfig?.stages?.length > 0)
  assert.equal(restoredFirm.stageConfig.stages[0].key, 'discovery')

  const login = secondStore.auth.login({ email: 'jordan+stage@example.com', password: 'StageConfig123!' })
  assert.ok(login.token)
  process.chdir(previousCwd)
})
