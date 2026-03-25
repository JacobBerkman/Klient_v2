import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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

test('local auth provider preserves register/login behavior', async () => {
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
      () => store.auth.login({ email: 'alex@example.com', password: 'invalid' }),
      /Invalid email or password/
    )
  }
  assert.throws(
    () => store.auth.login({ email: 'alex@example.com', password: 'invalid' }),
    /Too many failed login attempts/
  )
})

test('local auth provider preserves password reset behavior', async () => {
  const store = await loadStoreWithIsolatedState()

  store.auth.register({
    firmName: 'Reset Partners',
    firstName: 'Jordan',
    lastName: 'Reed',
    email: 'jordan@example.com',
    password: 'AnotherSecure123!'
  })

  const reset = store.auth.requestReset({ email: 'jordan@example.com' })
  assert.ok(reset.token)

  assert.throws(() => store.auth.resetPassword({ token: reset.token, password: 'weak' }), /Password must/)

  const result = store.auth.resetPassword({ token: reset.token, password: 'ResetSecure123!' })
  assert.deepEqual(result, { ok: true })

  const login = store.auth.login({ email: 'jordan@example.com', password: 'ResetSecure123!' })
  assert.equal(store.requireUser(login.token).email, 'jordan@example.com')
})

test('legacy store auth methods remain backward-compatible aliases', async () => {
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

  assert.deepEqual(store.resetPassword({ token: reset.token, password: 'AliasReset123!' }), { ok: true })
  const session = store.login({ email: 'morgan@example.com', password: 'AliasReset123!' })
  assert.equal(store.requireUser(session.token).email, 'morgan@example.com')
})
