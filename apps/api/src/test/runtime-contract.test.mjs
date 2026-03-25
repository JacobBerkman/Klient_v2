import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const previousCwd = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'klient-store-test-'))
process.chdir(tempDir)
process.env.APP_SECRET = 'test-secret-for-store-specs'
const moduleUrl = pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}`
const imported = await import(moduleUrl)
const store = imported.createStore()

test('store enforces strong passwords and session expiration', () => {
  assert.throws(() => {
    store.register({
      firmName: 'Weak Password Wealth',
      firstName: 'Casey',
      lastName: 'Jones',
      email: 'casey@example.com',
      password: 'weakpass'
    })
  }, /Password must/)

  const session = store.register({
    firmName: 'Secure Wealth',
    firstName: 'Alex',
    lastName: 'Stone',
    email: 'alex@example.com',
    password: 'SecurePass123!'
  })

  assert.equal(store.requireUser(session.token).email, 'alex@example.com')
  store.state.sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString()
  assert.throws(() => store.requireUser(session.token), /Authentication required/)
})

test('store rate limits repeated failed logins', () => {
  store.register({
    firmName: 'Login Guard Partners',
    firstName: 'Jordan',
    lastName: 'Reed',
    email: 'jordan@example.com',
    password: 'AnotherSecure123!'
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(
      () => store.login({ email: 'jordan@example.com', password: 'bad-password' }),
      /Invalid email or password/
    )
  }

  assert.throws(
    () => store.login({ email: 'jordan@example.com', password: 'bad-password' }),
    /Too many failed login attempts/
  )
})

process.chdir(previousCwd)
