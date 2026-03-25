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
    auth: {
      requireUser: (token) => {
        if (!token) throw new Error('Authentication required.')
        return fakeUser
      }
    },
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

test('pipeline stage config routes are transport-only and call pipelineStages module', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: () => calls.push('policy.requireGuard') },
    pipelineStages: {
      listStages: (user) => (calls.push(`list:${user.id}`), { stages: [] }),
      createStage: (user, payload) => (calls.push({ op: 'create', user: user.id, payload }), { id: 'stage-1' })
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const listRes = await fetch(`${base}/api/pipeline/stages`, { headers: { authorization: 'Bearer token' } })
  const listBody = await listRes.json()
  assert.equal(listRes.status, 200)
  assert.deepEqual(listBody, { stages: [] })

  const createRes = await fetch(`${base}/api/pipeline/stages`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'new_stage', label: 'New Stage' })
  })
  const createBody = await createRes.json()
  assert.equal(createRes.status, 201)
  assert.equal(createBody.id, 'stage-1')
  assert.deepEqual(calls, ['list:u1', { op: 'create', user: 'u1', payload: { key: 'new_stage', label: 'New Stage' } }])

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
      rotateSession: (token, reason) =>
        (calls.push({ route: 'rotateSession', token, reason }), { token: 'rotated-token', user: fakeUser }),
      rotateMfaBackupCodes: (user) => (calls.push(`auth.rotate:${user.id}`), { backupCodes: ['NEW-123'] })
    },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)

  const headers = { authorization: 'Bearer token', 'content-type': 'application/json' }
  const base = `http://${address.address}:${address.port}`
  const csrfBootstrap = await fetch(`${base}/api/csrf`, { headers: { authorization: 'Bearer token' } })
  const csrfPayload = await csrfBootstrap.json()
  let csrfCookie = (csrfBootstrap.headers.get('set-cookie') || '').split(';')[0]
  let csrfToken = csrfPayload.csrfToken
  const nextHeaders = () => ({
    ...headers,
    Origin: base,
    Referer: `${base}/`,
    Cookie: csrfCookie,
    'X-CSRF-Token': csrfToken
  })
  const rotateFrom = (response) => {
    csrfToken = response.headers.get('x-csrf-token') || csrfToken
    const setCookie = response.headers.get('set-cookie') || ''
    if (setCookie) csrfCookie = setCookie.split(';')[0]
  }

  const enrollRes = await fetch(`${base}/api/auth/mfa/enroll`, { method: 'POST', headers: nextHeaders(), body: '{}' })
  rotateFrom(enrollRes)
  const enrollBody = await enrollRes.json()
  assert.equal(enrollRes.status, 200)
  assert.equal(enrollBody.ok, true)

  const confirmRes = await fetch(`${base}/api/auth/mfa/enroll/confirm`, {
    method: 'POST',
    headers: nextHeaders(),
    body: JSON.stringify({ enrollmentToken: 'enroll-1', code: '123456' })
  })
  rotateFrom(confirmRes)
  const confirmBody = await confirmRes.json()
  assert.equal(confirmRes.status, 200)
  assert.deepEqual(confirmBody.mfa.backupCodes, ['ABC-123'])

  const challengeRes = await fetch(`${base}/api/auth/mfa/challenge`, { method: 'POST', headers: nextHeaders(), body: '{}' })
  rotateFrom(challengeRes)
  assert.equal(challengeRes.status, 200)

  const verifyRes = await fetch(`${base}/api/auth/mfa/verify`, {
    method: 'POST',
    headers: nextHeaders(),
    body: JSON.stringify({ challengeToken: 'challenge-1', totpCode: '654321' })
  })
  rotateFrom(verifyRes)
  const verifyBody = await verifyRes.json()
  assert.equal(verifyRes.status, 200)
  assert.equal(verifyBody.sessionRotated, true)
  assert.equal(verifyBody.token, 'rotated-token')

  const rotateRes = await fetch(`${base}/api/auth/mfa/backup-codes/rotate`, { method: 'POST', headers: nextHeaders(), body: '{}' })
  const rotateBody = await rotateRes.json()
  assert.equal(rotateRes.status, 200)
  assert.deepEqual(rotateBody.mfa.backupCodes, ['NEW-123'])

  assert(calls.includes('auth.enroll:u1'))
  assert(calls.includes('auth.challenge:u1'))
  assert(calls.includes('auth.rotate:u1'))
  assert.equal(calls.filter((entry) => entry === 'policy:u1:canReadSession').length, 5)
  assert.ok(calls.find((entry) => entry?.route === 'confirm'))
  assert.ok(calls.find((entry) => entry?.route === 'verify'))
  assert.ok(calls.find((entry) => entry?.route === 'rotateSession' && entry.reason === 'mfa_verified'))

  await close(server)
})

test('POST /api/login rotates prior bearer token to prevent fixation', async () => {
  const calls = []
  const modules = {
    auth: {
      login: () => ({ token: 'fresh-token', user: { id: 'u1', firmId: 'f1', role: 'advisor' } }),
      requireUser: () => ({ id: 'u1', firmId: 'f1', role: 'advisor' }),
      logout: (token) => calls.push(`logout:${token}`)
    },
    policy: { requireGuard: () => true }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const res = await fetch(`http://${address.address}:${address.port}/api/login`, {
    method: 'POST',
    headers: { authorization: 'Bearer stale-token', 'content-type': 'application/json', 'x-api-compatibility-bearer': '1' },
    body: JSON.stringify({ email: 'mfa@example.com', password: 'secret' })
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.token === 'fresh-token' || body.token === undefined)
  assert.deepEqual(calls, ['logout:stale-token'])
  await close(server)
})

test('GET /api/analytics/export requires auth and applies download headers', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    analytics: { exportCsv: () => 'metric,value\nprofiles,3\n' }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const authorized = await fetch(`${base}/api/analytics/export`, {
    headers: { authorization: 'Bearer token' }
  })
  const csv = await authorized.text()

  assert.equal(authorized.status, 200)
  assert.equal(authorized.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.match(authorized.headers.get('content-disposition') || '', /^attachment; filename=\"analytics-report-\d{4}-\d{2}-\d{2}\.csv\"$/)
  assert.equal(csv.includes('profiles,3'), true)
  assert.deepEqual(calls, ['policy:u1:canReadAnalytics'])
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

test('stage config routes are wired through policy + pipeline service', async (t) => {
  const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  if (!serverSource.includes('/api/pipeline/stages')) {
    t.skip('stage-config routes are not present in this branch')
    return
  }

  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), fakeUser) },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    pipeline: {
      listPipelineStages: (user) => (calls.push(`pipeline.listPipelineStages:${user.id}`), [{ key: 'discovery' }]),
      createPipelineStage: (user, payload) => (calls.push({ route: 'create', user: user.id, payload }), { key: payload.key }),
      reorderPipelineStages: (user, payload) => (calls.push({ route: 'reorder', user: user.id, payload }), { stages: payload.stageOrder }),
      deactivatePipelineStage: (user, stageKey) => (calls.push({ route: 'deactivate', user: user.id, stageKey }), { key: stageKey, active: false })
    }
  }

  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const listRes = await fetch(`${base}/api/pipeline/stages`, { headers: { authorization: 'Bearer token' } })
  assert.equal(listRes.status, 200)

  const createRes = await fetch(`${base}/api/pipeline/stages`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'estate_planning', label: 'Estate Planning' })
  })
  assert.equal(createRes.status, 201)

  const reorderRes = await fetch(`${base}/api/pipeline/stages/reorder`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({ stageOrder: ['estate_planning', 'discovery'] })
  })
  assert.equal(reorderRes.status, 200)

  const deactivateRes = await fetch(`${base}/api/pipeline/stages/estate_planning/deactivate`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer token' }
  })
  assert.equal(deactivateRes.status, 200)

  assert.ok(calls.find((entry) => entry === 'pipeline.listPipelineStages:u1'))
  assert.ok(calls.find((entry) => entry?.route === 'create'))
  assert.ok(calls.find((entry) => entry?.route === 'reorder'))
  assert.ok(calls.find((entry) => entry?.route === 'deactivate'))

  await close(server)
})
