import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createHttpServer } from '../server.mjs'

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

test('GET /api/dashboard routes through policy + profiles service', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), fakeUser) },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    profiles: { getDashboard: (user) => (calls.push(`profiles.getDashboard:${user.id}`), { ok: true }) }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const res = await fetch(`http://${address.address}:${address.port}/api/dashboard`, {
    headers: { authorization: 'Bearer token' }
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(calls, ['auth.requireUser', 'policy:u1:canViewDashboard', 'profiles.getDashboard:u1'])
  await close(server)
})

test('GET /api/profiles forwards query params to profiles service', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: () => calls.push('policy') },
    profiles: {
      listProfiles: (_user, query) => {
        calls.push(query)
        return [{ id: 'p1' }]
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const res = await fetch(`http://${address.address}:${address.port}/api/profiles?kind=prospect&search=casey`, {
    headers: { authorization: 'Bearer token' }
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.length, 1)
  assert.deepEqual(calls, ['policy', { kind: 'prospect', search: 'casey' }])
  await close(server)
})

test('POST /api/login handles mfaRequired responses without issuing csrf tokens', async () => {
  const modules = {
    auth: {
      login: () => ({ mfaRequired: true, challengeToken: 'mfa-token', methods: ['totp', 'backup_code'] })
    },
    policy: { requireGuard: () => true }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const res = await fetch(`http://${address.address}:${address.port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'mfa@example.com', password: 'secret' })
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.mfaRequired, true)
  assert.equal(body.csrfToken, null)
  await close(server)
})

test('authenticated MFA routes enforce policy + forward payloads', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: {
      requireUser: () => (calls.push('auth.requireUser'), fakeUser),
      enrollMfa: (user) => (calls.push(`auth.enroll:${user.id}`), { enrollmentToken: 'enroll-1' }),
      confirmMfaEnrollment: (user, payload) =>
        (calls.push({ route: 'confirm', user: user.id, payload }), { ok: true, backupCodes: ['ABC-123'] }),
      challengeMfa: (user) => (calls.push(`auth.challenge:${user.id}`), { challengeToken: 'challenge-1' }),
      verifyMfaChallenge: (user, payload) => (calls.push({ route: 'verify', user: user.id, payload }), { ok: true }),
      rotateMfaBackupCodes: (user) => (calls.push(`auth.rotate:${user.id}`), { backupCodes: ['NEW-123'] })
    },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)

  const headers = { authorization: 'Bearer token', 'content-type': 'application/json' }
  const base = `http://${address.address}:${address.port}`

  const enrollRes = await fetch(`${base}/api/auth/mfa/enroll`, { method: 'POST', headers, body: '{}' })
  const enrollBody = await enrollRes.json()
  assert.equal(enrollRes.status, 200)
  assert.equal(enrollBody.ok, true)

  const confirmRes = await fetch(`${base}/api/auth/mfa/enroll/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ enrollmentToken: 'enroll-1', code: '123456' })
  })
  const confirmBody = await confirmRes.json()
  assert.equal(confirmRes.status, 200)
  assert.deepEqual(confirmBody.mfa.backupCodes, ['ABC-123'])

  const challengeRes = await fetch(`${base}/api/auth/mfa/challenge`, { method: 'POST', headers, body: '{}' })
  assert.equal(challengeRes.status, 200)

  const verifyRes = await fetch(`${base}/api/auth/mfa/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ challengeToken: 'challenge-1', totpCode: '654321' })
  })
  assert.equal(verifyRes.status, 200)

  const rotateRes = await fetch(`${base}/api/auth/mfa/backup-codes/rotate`, { method: 'POST', headers, body: '{}' })
  const rotateBody = await rotateRes.json()
  assert.equal(rotateRes.status, 200)
  assert.deepEqual(rotateBody.mfa.backupCodes, ['NEW-123'])

  assert.deepEqual(calls, [
    'auth.requireUser',
    'policy:u1:canReadSession',
    'auth.enroll:u1',
    'auth.requireUser',
    'policy:u1:canReadSession',
    { route: 'confirm', user: 'u1', payload: { enrollmentToken: 'enroll-1', code: '123456' } },
    'auth.requireUser',
    'policy:u1:canReadSession',
    'auth.challenge:u1',
    'auth.requireUser',
    'policy:u1:canReadSession',
    { route: 'verify', user: 'u1', payload: { challengeToken: 'challenge-1', totpCode: '654321' } },
    'auth.requireUser',
    'policy:u1:canReadSession',
    'auth.rotate:u1'
  ])

  await close(server)
})

test('server routes do not call store domain mutation methods directly', () => {
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const forbidden = [
    'store.createProfile(',
    'store.updateProfile(',
    'store.reorderBoard(',
    'store.createHousehold(',
    'store.createFormSubmission(',
    'store.createDocumentTemplate(',
    'store.createExport(',
    'store.listAudit(',
    'store.getAnalytics('
  ]

  forbidden.forEach((pattern) => {
    assert.equal(serverSource.includes(pattern), false, `Expected server route transport layer to avoid ${pattern}`)
  })
})
