import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createRateLimiter } from '../security/rate-limit.mjs'

const repoRoot = process.cwd()

// The HTTP-level tests opt INTO the limiter under NODE_ENV=test (the runtime
// default is off in test, mirroring ENABLE_TEST_CSRF_BYPASS) with a tiny
// budget so the 429 path is reachable in a handful of requests. Env must be
// shaped before the first (cached) import of runtime.mjs below.
process.env.NODE_ENV = 'test'
process.env.APP_SECRET = 'rate-limit-test-secret-abcdefghijklmnopqrstuvwxyz'
process.env.AUTH_PROVIDER = 'local'
process.env.RATE_LIMIT_ENABLED = 'true'
process.env.RATE_LIMIT_MAX_REQUESTS = '3'
process.env.RATE_LIMIT_WINDOW_SECONDS = '60'
delete process.env.KLIENT_OPS_TOKEN

// --- Limiter unit tests -------------------------------------------------------

test('limiter: sliding window rolls over and frees budget', () => {
  let nowMs = 100_000
  const limiter = createRateLimiter({ maxRequests: 3, windowSeconds: 60, now: () => nowMs })
  try {
    assert.equal(limiter.check('key-a').allowed, true)
    assert.equal(limiter.check('key-a').allowed, true)
    assert.equal(limiter.check('key-a').allowed, true)

    const denied = limiter.check('key-a')
    assert.equal(denied.allowed, false)
    assert.ok(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= 60, 'Retry-After stays inside the window')

    // Half a window later the oldest hits are still live: still denied.
    nowMs += 30_000
    assert.equal(limiter.check('key-a').allowed, false)

    // Past the window the budget frees up again.
    nowMs += 31_000
    const allowedAgain = limiter.check('key-a')
    assert.equal(allowedAgain.allowed, true)
    assert.equal(allowedAgain.remaining, 2, 'window rolled over to a fresh budget')
  } finally {
    limiter.stop()
  }
})

test('limiter: keys are isolated from each other', () => {
  let nowMs = 200_000
  const limiter = createRateLimiter({ maxRequests: 2, windowSeconds: 60, now: () => nowMs })
  try {
    assert.equal(limiter.check('key-a').allowed, true)
    assert.equal(limiter.check('key-a').allowed, true)
    assert.equal(limiter.check('key-a').allowed, false)
    assert.equal(limiter.check('key-b').allowed, true, 'exhausting key-a never affects key-b')
    assert.equal(limiter.check('key-b').allowed, true)
    assert.equal(limiter.check('key-b').allowed, false)
  } finally {
    limiter.stop()
  }
})

test('limiter: prune drops expired timestamps and empty keys', () => {
  let nowMs = 300_000
  const limiter = createRateLimiter({ maxRequests: 5, windowSeconds: 60, now: () => nowMs })
  try {
    limiter.check('key-a')
    limiter.check('key-b')
    assert.equal(limiter.keyCount, 2)

    nowMs += 61_000
    limiter.check('key-c')
    assert.equal(limiter.prune(), 1, 'expired keys are dropped; live keys survive')
    assert.equal(limiter.keyCount, 1)
  } finally {
    limiter.stop()
  }
})

test('limiter: max-keys cap evicts the least-recently-seen key', () => {
  let nowMs = 400_000
  const limiter = createRateLimiter({ maxRequests: 5, windowSeconds: 60, maxTrackedKeys: 3, now: () => nowMs })
  try {
    limiter.check('key-a')
    limiter.check('key-b')
    limiter.check('key-c')
    assert.equal(limiter.keyCount, 3)

    // Touch key-a so key-b becomes least-recently-seen, then overflow the cap.
    limiter.check('key-a')
    limiter.check('key-d')
    assert.equal(limiter.keyCount, 3, 'tracked keys never exceed the cap')

    // key-b was evicted: it restarts with a fresh budget (full remaining).
    assert.equal(limiter.check('key-b').remaining, 4)
    // key-a survived the eviction with its two hits still counted.
    assert.equal(limiter.check('key-a').remaining, 2)
  } finally {
    limiter.stop()
  }
})

// --- HTTP-level integration ---------------------------------------------------

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

async function loadTestServer() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-rate-limit-'))
  process.chdir(tempDir)
  const [{ createHttpServer }, { createStore }, { createModules }, { SqliteReadRepository }, { closeDatabase }] =
    await Promise.all([
      import(pathToFileURL(resolve(repoRoot, 'apps/api/src/server.mjs')).href + `?t=${Date.now()}`),
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
    closeDatabase,
    baseUrl: `http://${address.address}:${address.port}`
  }
}

test('HTTP: /api/* requests are limited per key with 429 + Retry-After; exemptions and keying hold', async () => {
  const context = await loadTestServer()
  try {
    // /health is exempt: more requests than the budget, never a 429.
    for (let i = 0; i < 5; i += 1) {
      const health = await fetch(`${context.baseUrl}/health`)
      assert.notEqual(health.status, 429, '/health must never be rate limited')
    }

    // /api/csrf is exempt too (session bootstrap must stay reachable).
    for (let i = 0; i < 5; i += 1) {
      const csrf = await fetch(`${context.baseUrl}/api/csrf`)
      assert.equal(csrf.status, 401, '/api/csrf stays reachable (auth error, not 429)')
    }

    // Login as the seeded demo admin. This cookieless POST is the first hit on
    // the IP bucket (login is /api/* and not exempt).
    const loginResponse = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    })
    assert.equal(loginResponse.status, 200)
    const adminCookie = cookieFrom(loginResponse.headers.get('set-cookie'), ['klient-session', '__Host-klient-session'])
    assert.ok(adminCookie, 'login issued a session cookie')

    // A second login (IP hit 2 of 3) yields an independent session whose own
    // bucket is still untouched once the first session's is exhausted below —
    // that is what lets the diagnostics assertion at the end get through.
    const secondLogin = await fetch(`${context.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    })
    assert.equal(secondLogin.status, 200)
    const diagnosticsCookie = cookieFrom(secondLogin.headers.get('set-cookie'), [
      'klient-session',
      '__Host-klient-session'
    ])
    assert.ok(diagnosticsCookie, 'second login issued its own session cookie')

    // Session-cookie keying: requests carrying a VALID session cookie consume
    // that session's own bucket, independent of the IP bucket.
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${context.baseUrl}/api/session`, { headers: { Cookie: adminCookie } })
      assert.equal(response.status, 200, `request ${i + 1} inside the session budget is processed`)
    }
    const limited = await fetch(`${context.baseUrl}/api/session`, { headers: { Cookie: adminCookie } })
    assert.equal(limited.status, 429, '4th request on the same valid session is limited')
    const retryAfter = Number(limited.headers.get('retry-after'))
    assert.ok(retryAfter >= 1 && retryAfter <= 60, 'Retry-After header is set inside the window')
    const limitedBody = await limited.json()
    assert.equal(limitedBody.error.code, 'RATE_LIMITED')
    assert.equal(limitedBody.error.statusCode, 429)
    assert.ok(limitedBody.error.requestId, '429 envelope carries the request id')
    assert.equal(limitedBody.error.details.retryAfterSeconds, retryAfter)

    // Forged/unknown session cookies must NOT mint their own bucket — otherwise
    // any caller could bypass the limit entirely by sending a random cookie per
    // request (and churn the limiter's key table). They fall back to IP keying.
    // The two logins already spent 2 of 3 on the IP bucket, so one forged
    // request fills it and the next forged cookie is refused.
    const forged = await fetch(`${context.baseUrl}/api/session`, {
      headers: { Cookie: 'klient-session=forged-session-0' }
    })
    assert.equal(forged.status, 401, 'a forged cookie consumes the IP budget (auth 401)')
    const forgedLimited = await fetch(`${context.baseUrl}/api/session`, {
      headers: { Cookie: 'klient-session=forged-session-final' }
    })
    assert.equal(forgedLimited.status, 429, 'a fresh forged cookie cannot escape the exhausted IP bucket')

    // A cookieless request lands in that same exhausted IP bucket.
    const ipLimited = await fetch(`${context.baseUrl}/api/session`)
    assert.equal(ipLimited.status, 429, 'IP bucket limits once its own budget is spent')

    // Ops diagnostics surfaces the counters. The second session is its own
    // untouched bucket, so this safe-method GET goes through.
    const diagnostics = await fetch(`${context.baseUrl}/api/ops/diagnostics`, {
      headers: { Cookie: diagnosticsCookie }
    })
    assert.equal(diagnostics.status, 200)
    const body = await diagnostics.json()
    const rateLimit = body.data.security.rateLimit
    assert.equal(rateLimit.enabled, true)
    assert.equal(rateLimit.maxRequests, 3)
    assert.equal(rateLimit.windowSeconds, 60)
    assert.ok(rateLimit.limitedTotal >= 2, 'both 429s are counted')
    assert.ok(rateLimit.limitedByKeyType.session >= 1, 'session-keyed rejection counted')
    assert.ok(rateLimit.limitedByKeyType.ip >= 1, 'ip-keyed rejection counted')
    assert.ok(rateLimit.trackedKeys >= 1, 'limiter reports tracked key count')
  } finally {
    await close(context.server)
    context.closeDatabase()
    process.chdir(context.previousCwd)
    try {
      rmSync(context.tempDir, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EPERM') throw error
    }
  }
})
