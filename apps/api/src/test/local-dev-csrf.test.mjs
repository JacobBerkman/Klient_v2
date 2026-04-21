import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

function cookieFrom(setCookie, names) {
  for (const name of names) {
    const match = String(setCookie || '').match(new RegExp(`${name}=([^;,\\s]*)`))
    if (match) return `${name}=${match[1]}`
  }
  return ''
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())))
}

async function loadDevServer() {
  const previousCwd = process.cwd()
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_DEV_FALLBACK_APP_SECRET: process.env.ALLOW_DEV_FALLBACK_APP_SECRET,
    APP_SECRET: process.env.APP_SECRET
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-local-dev-csrf-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'development'
  process.env.ALLOW_DEV_FALLBACK_APP_SECRET = 'true'
  process.env.APP_SECRET = 'local-dev-csrf-secret-abcdefghijklmnopqrstuvwxyz'
  const serverUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/server.mjs')).href + `?t=${Date.now()}`
  const [{ createHttpServer }, { createStore }, { createModules }, { SqliteReadRepository }, { closeDatabase }] =
    await Promise.all([
      import(serverUrl),
      import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-store`),
      import(pathToFileURL(resolve(repoRoot, 'apps/api/src/modules/index.mjs')).href + `?t=${Date.now()}-modules`),
      import(
        pathToFileURL(resolve(repoRoot, 'apps/api/src/repositories/sqlite-read-repository.mjs')).href +
          `?t=${Date.now()}-reads`
      ),
      import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href)
    ])
  const store = createStore()
  const reads = new SqliteReadRepository()
  const modules = createModules({ store, reads })
  const server = createHttpServer({ modules })
  const address = await listen(server)
  return {
    server,
    tempDir,
    previousCwd,
    previousEnv,
    closeDatabase,
    baseUrl: `http://${address.address}:${address.port}`
  }
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function csrfHeaders(baseUrl, sessionCookie, origin = 'http://localhost:5173') {
  const response = await fetch(`${baseUrl}/api/csrf`, {
    headers: {
      Cookie: sessionCookie,
      'x-forwarded-host': 'localhost:5173',
      'x-forwarded-proto': 'http'
    }
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  const csrfCookie = cookieFrom(response.headers.get('set-cookie'), ['klient-csrf', '__Host-klient-csrf'])
  assert.ok(csrfCookie.startsWith('klient-csrf='), 'local HTTP csrf cookie should use the unprefixed name')
  return {
    Cookie: `${sessionCookie}; ${csrfCookie}`,
    'Content-Type': 'application/json',
    'X-CSRF-Token': body.csrfToken,
    Origin: origin,
    Referer: `${origin}/`,
    'x-forwarded-host': 'localhost:5173',
    'x-forwarded-proto': 'http'
  }
}

test('local development uses browser-accepted cookies and accepts Vite-origin CSRF mutations', async () => {
  const context = await loadDevServer()
  try {
    const loginResponse = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    })
    const login = await loginResponse.json()
    assert.equal(loginResponse.status, 200)
    assert.equal(login.user.email, 'admin@demo.test')

    const loginSetCookie = loginResponse.headers.get('set-cookie') || ''
    const sessionCookie = cookieFrom(loginSetCookie, ['klient-session', '__Host-klient-session'])
    assert.ok(sessionCookie.startsWith('klient-session='), 'local HTTP session cookie should use the unprefixed name')
    assert.equal(loginSetCookie.includes('__Host-klient-session='), false)
    assert.equal(loginSetCookie.includes('Secure'), false)
    assert.equal(loginSetCookie.includes('SameSite=Strict'), true)

    const sessionResponse = await fetch(`${context.baseUrl}/api/session`, {
      headers: { Cookie: sessionCookie }
    })
    const session = await sessionResponse.json()
    assert.equal(sessionResponse.status, 200)
    assert.equal(session.user.email, 'admin@demo.test')

    const createProfileResponse = await fetch(`${context.baseUrl}/api/profiles`, {
      method: 'POST',
      headers: await csrfHeaders(context.baseUrl, sessionCookie),
      body: JSON.stringify({
        kind: 'client',
        firstName: 'Local',
        lastName: 'Dev',
        email: `local-dev-${Date.now()}@example.test`
      })
    })
    const profile = await createProfileResponse.json()
    assert.equal(createProfileResponse.status, 201, JSON.stringify(profile))

    const patchResponse = await fetch(`${context.baseUrl}/api/profiles/${profile.id}`, {
      method: 'PATCH',
      headers: await csrfHeaders(context.baseUrl, sessionCookie),
      body: JSON.stringify({ phone: '555-0100' })
    })
    const patched = await patchResponse.json()
    assert.equal(patchResponse.status, 200, JSON.stringify(patched))
    assert.equal(patched.phone, '555-0100')

    const createFieldResponse = await fetch(`${context.baseUrl}/api/profiles/custom-fields/schema`, {
      method: 'POST',
      headers: await csrfHeaders(context.baseUrl, sessionCookie),
      body: JSON.stringify({ key: 'local_dev_delete_guard', type: 'text' })
    })
    assert.equal(createFieldResponse.status, 201)

    const deleteResponse = await fetch(`${context.baseUrl}/api/profiles/custom-fields/schema/local_dev_delete_guard`, {
      method: 'DELETE',
      headers: await csrfHeaders(context.baseUrl, sessionCookie)
    })
    assert.equal(deleteResponse.status, 200)
  } finally {
    await close(context.server)
    context.closeDatabase()
    process.chdir(context.previousCwd)
    restoreEnv(context.previousEnv)
    try {
      rmSync(context.tempDir, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EPERM') throw error
    }
  }
})
