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

async function withCapturedLogs(run) {
  const originalLog = console.log
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))
  try {
    await run(lines)
  } finally {
    console.log = originalLog
  }
  return lines
}

function requestCompletedLogEntry(lines) {
  const parsed = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return parsed.find((entry) => entry.message === 'request.completed')
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
    headers: { cookie: '__Host-klient-session=token' }
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
    headers: { cookie: '__Host-klient-session=token' }
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.length, 1)
  assert.deepEqual(calls, ['policy', { kind: 'prospect', search: 'casey' }])
  await close(server)
})

test('request.completed logs omit query strings by default', async () => {
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: () => true },
    profiles: { listProfiles: () => [] }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const lines = await withCapturedLogs(async () => {
    await fetch(`${base}/api/profiles?kind=prospect&search=casey&token=raw-token-value&secret=raw-secret`, {
      headers: { cookie: '__Host-klient-session=token' }
    })
  })
  const entry = requestCompletedLogEntry(lines)
  assert.ok(entry)
  assert.equal(entry.path, '/api/profiles')
  assert.equal(entry.path.includes('raw-token-value'), false)
  assert.equal(entry.path.includes('raw-secret'), false)

  await close(server)
})

test('request.completed logs redact sensitive query values when LOG_REQUEST_QUERY=true', async () => {
  process.env.LOG_REQUEST_QUERY = 'true'
  try {
    const { createHttpServer: createHttpServerWithQueryLogging } = await import(
      new URL(`../server.mjs?query-logging=${Date.now()}`, import.meta.url)
    )
    const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
    const modules = {
      auth: { requireUser: () => fakeUser },
      policy: { requireGuard: () => true },
      profiles: { listProfiles: () => [] }
    }
    const server = createHttpServerWithQueryLogging({
      modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} })
    })
    const address = await listen(server)
    const base = `http://${address.address}:${address.port}`

    const lines = await withCapturedLogs(async () => {
      await fetch(`${base}/api/profiles?kind=prospect&search=casey&token=raw-token-value&session=abc123&foo=bar`, {
        headers: { cookie: '__Host-klient-session=token' }
      })
    })
    const entry = requestCompletedLogEntry(lines)
    assert.ok(entry)
    assert.equal(
      entry.path,
      '/api/profiles?kind=prospect&search=casey&token=%5BREDACTED%5D&session=%5BREDACTED%5D&foo=%5BOMITTED%5D'
    )
    assert.equal(entry.path.includes('raw-token-value'), false)
    assert.equal(entry.path.includes('abc123'), false)

    await close(server)
  } finally {
    delete process.env.LOG_REQUEST_QUERY
  }
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
  const cookie = '__Host-klient-session=token'
  const issueHeaders = async (json = false) => {
    const bootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie } })
    const payload = await bootstrap.json()
    return {
      cookie,
      ...(json ? { 'content-type': 'application/json' } : {}),
      'x-csrf-token': payload.csrfToken,
      origin: base,
      referer: `${base}/`
    }
  }

  const listRes = await fetch(`${base}/api/pipeline/stages`, { headers: { cookie } })
  const listBody = await listRes.json()
  assert.equal(listRes.status, 200)
  assert.deepEqual(listBody, { stages: [] })

  const createRes = await fetch(`${base}/api/pipeline/stages`, {
    method: 'POST',
    headers: await issueHeaders(true),
    body: JSON.stringify({ key: 'new_stage', label: 'New Stage' })
  })
  const createBody = await createRes.json()
  assert.equal(createRes.status, 201)
  assert.equal(createBody.id, 'stage-1')
  assert.deepEqual(calls, ['list:u1', { op: 'create', user: 'u1', payload: { key: 'new_stage', label: 'New Stage' } }])

  await close(server)
})

test('custom field schema routes enforce admin guard and forward payloads', async () => {
  const calls = []
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    profiles: {
      getCustomFieldSchema: (user) => (calls.push(`get:${user.id}`), { fields: [] }),
      createCustomField: (user, payload) => (calls.push({ op: 'create', user: user.id, payload }), { ...payload }),
      updateCustomField: (user, fieldKey, payload) =>
        (calls.push({ op: 'update', user: user.id, fieldKey, payload }), { key: fieldKey, ...payload }),
      deleteCustomField: (user, fieldKey) => (calls.push({ op: 'delete', user: user.id, fieldKey }), { ok: true })
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`
  const cookie = '__Host-klient-session=token'
  const issueHeaders = async (json = false) => {
    const bootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie } })
    const payload = await bootstrap.json()
    return {
      cookie,
      ...(json ? { 'content-type': 'application/json' } : {}),
      'x-csrf-token': payload.csrfToken,
      origin: base,
      referer: `${base}/`
    }
  }

  const listRes = await fetch(`${base}/api/profiles/custom-fields/schema`, { headers: { cookie } })
  assert.equal(listRes.status, 200)

  const createRes = await fetch(`${base}/api/profiles/custom-fields/schema`, {
    method: 'POST',
    headers: await issueHeaders(true),
    body: JSON.stringify({ key: 'risk_tolerance', type: 'text' })
  })
  assert.equal(createRes.status, 201)

  const updateRes = await fetch(`${base}/api/profiles/custom-fields/schema/risk_tolerance`, {
    method: 'PATCH',
    headers: await issueHeaders(true),
    body: JSON.stringify({ required: true })
  })
  assert.equal(updateRes.status, 200)

  const deleteRes = await fetch(`${base}/api/profiles/custom-fields/schema/risk_tolerance`, {
    method: 'DELETE',
    headers: await issueHeaders(false)
  })
  assert.equal(deleteRes.status, 200)
  assert.deepEqual(calls, [
    'policy:u1:canReadProfiles',
    'get:u1',
    'policy:u1:canManageUsers',
    { op: 'create', user: 'u1', payload: { key: 'risk_tolerance', type: 'text' } },
    'policy:u1:canManageUsers',
    { op: 'update', user: 'u1', fieldKey: 'risk_tolerance', payload: { required: true } },
    'policy:u1:canManageUsers',
    { op: 'delete', user: 'u1', fieldKey: 'risk_tolerance' }
  ])
  await close(server)
})

test('custom field schema routes keep read access for advisor/readonly but enforce admin-only mutations', async () => {
  for (const role of ['advisor', 'readonly']) {
    const fakeUser = { id: `${role}-u1`, firmId: 'f1', role }
    const modules = {
      auth: { requireUser: () => fakeUser },
      policy: {
        requireGuard: (user, guard) => {
          if (guard === 'canManageUsers' && user.role !== 'admin') {
            const error = new Error('Missing permission: canManageUsers')
            error.statusCode = 403
            throw error
          }
        }
      },
      profiles: {
        getCustomFieldSchema: () => ({ fields: [] }),
        createCustomField: () => ({})
      }
    }
    const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
    const address = await listen(server)
    const base = `http://${address.address}:${address.port}`
    const cookie = '__Host-klient-session=token'

    const listRes = await fetch(`${base}/api/profiles/custom-fields/schema`, { headers: { cookie } })
    assert.equal(listRes.status, 200, `${role} should retain schema read access`)

    const csrfRes = await fetch(`${base}/api/csrf`, { headers: { cookie } })
    const csrfBody = await csrfRes.json()
    const createRes = await fetch(`${base}/api/profiles/custom-fields/schema`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': csrfBody.csrfToken,
        origin: base,
        referer: `${base}/`
      },
      body: JSON.stringify({ key: 'blocked_for_role', type: 'text' })
    })
    assert.equal(createRes.status, 403, `${role} should be blocked from schema mutation`)
    await close(server)
  }
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

  const headers = { cookie: '__Host-klient-session=token', 'content-type': 'application/json' }
  const base = `http://${address.address}:${address.port}`
  const csrfBootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie: '__Host-klient-session=token' } })
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

test('POST /api/login rotates prior session token to prevent fixation', async () => {
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
    headers: { cookie: '__Host-klient-session=stale-token', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'mfa@example.com', password: 'secret' })
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.token, undefined)
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
    headers: { cookie: '__Host-klient-session=token' }
  })
  const csv = await authorized.text()

  assert.equal(authorized.status, 200)
  assert.equal(authorized.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.match(authorized.headers.get('content-disposition') || '', /^attachment; filename=\"analytics-report-\d{4}-\d{2}-\d{2}\.csv\"$/)
  assert.equal(csv.includes('profiles,3'), true)
  assert.deepEqual(calls, ['policy:u1:canReadAnalytics'])
  await close(server)
})

test('workflow draft revision route enforces policy before mutation and preserves tenant user context', async () => {
  const calls = []
  const fakeUser = { id: 'u-draft-1', firmId: 'firm-1', role: 'advisor' }
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), fakeUser) },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    forms: {
      reviseDraftSubmission: (user, draftId, payload) => {
        calls.push({ route: 'forms.reviseDraftSubmission', user, draftId, payload })
        return { id: draftId, ...payload }
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`
  const cookie = '__Host-klient-session=token'
  const csrfBootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie } })
  const csrfPayload = await csrfBootstrap.json()
  const csrfToken = csrfPayload.csrfToken

  const patchRes = await fetch(`${base}/api/forms/drafts/draft-123`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, origin: base, referer: `${base}/` },
    body: JSON.stringify({ status: 'draft', values: { fieldA: 'updated' } })
  })
  const patchBody = await patchRes.json()
  assert.equal(patchRes.status, 200)
  assert.equal(patchBody.id, 'draft-123')
  const formsCallIndex = calls.findIndex((entry) => entry?.route === 'forms.reviseDraftSubmission')
  const canWriteFormsIndex = calls.indexOf('policy:u-draft-1:canWriteForms')
  const canWriteCollaboratorIndex = calls.indexOf('policy:u-draft-1:canWriteDraftCollaborator')
  assert.ok(canWriteFormsIndex >= 0)
  assert.ok(canWriteCollaboratorIndex >= 0)
  assert.ok(formsCallIndex > canWriteFormsIndex)
  assert.ok(formsCallIndex > canWriteCollaboratorIndex)
  assert.deepEqual(calls[formsCallIndex], {
    route: 'forms.reviseDraftSubmission',
    user: fakeUser,
    draftId: 'draft-123',
    payload: { status: 'draft', values: { fieldA: 'updated' } }
  })

  await close(server)
})

test('POST /api/templates/auto-build keeps csrf bootstrap + token flow for state-changing requests', async () => {
  const calls = []
  const fakeUser = { id: 'u-template-1', firmId: 'firm-1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    templates: {
      autoBuild: (user, payload) => {
        calls.push({ route: 'templates.autoBuild', user: user.id, payload })
        return { id: 'tpl-autobuild-1', ...payload }
      }
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`
  const cookie = '__Host-klient-session=token'

  const missingCsrfRes = await fetch(`${base}/api/templates/auto-build`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: base, referer: `${base}/` },
    body: JSON.stringify({ name: 'NoCsrf' })
  })
  assert.equal(missingCsrfRes.status, 403)

  const csrfBootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie } })
  const csrfPayload = await csrfBootstrap.json()
  const withCsrfRes = await fetch(`${base}/api/templates/auto-build`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': csrfPayload.csrfToken,
      origin: base,
      referer: `${base}/`
    },
    body: JSON.stringify({ name: 'WithCsrf', fileName: 'source.pdf' })
  })
  const withCsrfBody = await withCsrfRes.json()
  assert.equal(withCsrfRes.status, 201)
  assert.equal(withCsrfBody.id, 'tpl-autobuild-1')
  assert.deepEqual(calls, [
    'policy:u-template-1:canEditTemplate',
    {
      route: 'templates.autoBuild',
      user: 'u-template-1',
      payload: { name: 'WithCsrf', fileName: 'source.pdf' }
    }
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
    pipelineStages: {
      listStages: (user) => (calls.push(`pipeline.listPipelineStages:${user.id}`), [{ key: 'discovery' }]),
      createStage: (user, payload) => (calls.push({ route: 'create', user: user.id, payload }), { key: payload.key }),
      reorderStages: (user, payload) => (calls.push({ route: 'reorder', user: user.id, payload }), { stages: payload.stageOrder }),
      deactivateStage: (user, stageKey) => (calls.push({ route: 'deactivate', user: user.id, stageKey }), { key: stageKey, active: false })
    }
  }

  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`
  const cookie = '__Host-klient-session=token'
  const csrfBootstrap = await fetch(`${base}/api/csrf`, { headers: { cookie } })
  const csrfPayload = await csrfBootstrap.json()
  let csrfToken = csrfPayload.csrfToken

  const listRes = await fetch(`${base}/api/pipeline/stages`, { headers: { cookie } })
  assert.equal(listRes.status, 200)

  const createRes = await fetch(`${base}/api/pipeline/stages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, origin: base, referer: `${base}/` },
    body: JSON.stringify({ key: 'estate_planning', label: 'Estate Planning' })
  })
  assert.equal(createRes.status, 201)
  csrfToken = createRes.headers.get('x-csrf-token') || csrfToken

  const reorderRes = await fetch(`${base}/api/pipeline/stages/reorder`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, origin: base, referer: `${base}/` },
    body: JSON.stringify({ stageOrder: ['estate_planning', 'discovery'] })
  })
  assert.equal(reorderRes.status, 200)
  csrfToken = reorderRes.headers.get('x-csrf-token') || csrfToken

  const deactivateRes = await fetch(`${base}/api/pipeline/stages/estate_planning/deactivate`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfToken, origin: base, referer: `${base}/` }
  })
  assert.equal(deactivateRes.status, 200)

  assert.ok(calls.find((entry) => entry === 'pipeline.listPipelineStages:u1'))
  assert.ok(calls.find((entry) => entry?.route === 'create'))
  assert.ok(calls.find((entry) => entry?.route === 'reorder'))
  assert.ok(calls.find((entry) => entry?.route === 'deactivate'))

  await close(server)
})


test('ops token auth grants access for diagnostics and exports queue endpoints', async () => {
  const calls = []
  const previousOpsToken = process.env.KLIENT_OPS_TOKEN
  process.env.KLIENT_OPS_TOKEN = 'ops-token-abcdefghijklmnopqrstuvwxyz'
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), { id: 'u1', role: 'admin' }) },
    policy: { requireGuard: () => calls.push('policy.requireGuard') },
    analytics: {
      getDiagnosticsContext: () => ({ auditEvents: [], exports: [] })
    },
    exports: {
      getQueueHealth: () => ({ queue: { pending: 0, active: 0 } })
    }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const diagnostics = await fetch(`${base}/api/ops/diagnostics`, {
    headers: { authorization: 'Bearer ops-token-abcdefghijklmnopqrstuvwxyz' }
  })
  assert.equal(diagnostics.status, 200)

  const queue = await fetch(`${base}/api/ops/exports/queue`, {
    headers: { authorization: 'Bearer ops-token-abcdefghijklmnopqrstuvwxyz' }
  })
  assert.equal(queue.status, 200)
  assert.deepEqual(calls, [])

  await close(server)
  if (previousOpsToken === undefined) delete process.env.KLIENT_OPS_TOKEN
  else process.env.KLIENT_OPS_TOKEN = previousOpsToken
})

test('ops token auth rejects missing or invalid token', async () => {
  const previousOpsToken = process.env.KLIENT_OPS_TOKEN
  process.env.KLIENT_OPS_TOKEN = 'ops-token-abcdefghijklmnopqrstuvwxyz'
  const modules = {
    auth: { requireUser: () => ({ id: 'u1', role: 'admin' }) },
    policy: { requireGuard: () => true },
    analytics: { getDiagnosticsContext: () => ({ auditEvents: [], exports: [] }) },
    exports: { getQueueHealth: () => ({ queue: { pending: 0, active: 0 } }) }
  }
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const missing = await fetch(`${base}/api/ops/diagnostics`)
  assert.equal(missing.status, 401)

  const invalid = await fetch(`${base}/api/ops/exports/queue`, {
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(invalid.status, 401)

  await close(server)
  if (previousOpsToken === undefined) delete process.env.KLIENT_OPS_TOKEN
  else process.env.KLIENT_OPS_TOKEN = previousOpsToken
})

test('ops endpoints preserve session + role authorization flow when ops token mode is disabled', async () => {
  const previousOpsToken = process.env.KLIENT_OPS_TOKEN
  delete process.env.KLIENT_OPS_TOKEN
  const calls = []
  const fakeUser = { id: 'u1', role: 'admin' }
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), fakeUser) },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    analytics: { getDiagnosticsContext: () => ({ auditEvents: [], exports: [] }) },
    exports: { getQueueHealth: () => ({ queue: { pending: 0, active: 0 } }) }
  }

  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) })
  const address = await listen(server)
  const base = `http://${address.address}:${address.port}`

  const diagnostics = await fetch(`${base}/api/ops/diagnostics`, {
    headers: { authorization: 'Bearer session-token' }
  })
  assert.equal(diagnostics.status, 200)

  const queue = await fetch(`${base}/api/ops/exports/queue`, {
    headers: { authorization: 'Bearer session-token' }
  })
  assert.equal(queue.status, 200)

  assert.deepEqual(calls, [
    'auth.requireUser',
    'policy:u1:canReadDiagnostics',
    'auth.requireUser',
    'policy:u1:canProcessExports'
  ])

  await close(server)
  if (previousOpsToken === undefined) delete process.env.KLIENT_OPS_TOKEN
  else process.env.KLIENT_OPS_TOKEN = previousOpsToken
})
