import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createEvidenceRecorder } from './release-evidence.mjs'

const evidence = createEvidenceRecorder({
  gate: 'contract',
  defaultFile: 'api-contract-summary.json',
  envVarName: 'RELEASE_EVIDENCE_CONTRACT_FILE',
  command: 'npm run test:contract'
})

process.on('exit', () => {
  if (process.exitCode && process.exitCode !== 0) {
    evidence.finalize({
      status: 'failed',
      error: new Error(`Process exited with code ${process.exitCode}.`)
    })
    return
  }
  evidence.finalize({ status: 'passed' })
})

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const serverEntrypoint = resolve(repoRoot, 'apps/api/src/server.mjs')

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

async function waitForServer(port) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // Server still starting.
    }

    await wait(100)
  }

  throw new Error(`Timed out waiting for server on port ${port}.`)
}

async function jsonFetch(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options)
  const data = await response.json()
  return { response, data }
}

function extractSessionCookie(response) {
  const raw = response.headers.get('set-cookie') || ''
  const match = ['klient-session', '__Host-klient-session']
    .map((name) =>
      raw
        .split(',')
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith(`${name}=`))
    )
    .find(Boolean)
  return match ? match.split(';')[0] : ''
}

function isSessionCookie(cookie) {
  return cookie.startsWith('klient-session=') || cookie.startsWith('__Host-klient-session=')
}

test('production Node server contract supports auth and profile workflows', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'klient-contract-'))
  const port = 3210 + Math.floor(Math.random() * 200)
  const server = spawn(process.execPath, [serverEntrypoint], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      ENABLE_TEST_CSRF_BYPASS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stderr = ''
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    server.kill('SIGTERM')
    await new Promise((resolveExit) => server.once('exit', resolveExit))
    await rm(cwd, { recursive: true, force: true })
  })

  await waitForServer(port)

  const { response: readyResponse, data: ready } = await jsonFetch(port, '/ready')
  assert.equal(readyResponse.status, 200)
  assert.equal(ready.status, 'ready')
  assert.equal(typeof ready.ready, 'boolean')
  assert.equal(typeof ready.checks.databaseReady, 'boolean')
  assert.equal(typeof ready.checks.storageReady, 'boolean')
  assert.equal(typeof ready.checks.exportQueueNotStalled, 'boolean')
  assert.equal(ready.ready, true)

  // Google interactive sign-in is config-gated: with no GOOGLE_CLIENT_ID/SECRET in
  // this server's env it must report disabled and the start route must 404.
  const { response: runtimeResponse, data: runtimePayload } = await jsonFetch(port, '/api/runtime')
  assert.equal(runtimeResponse.status, 200)
  assert.equal(runtimePayload.googleAuthEnabled, false)
  const googleStartResponse = await fetch(`http://127.0.0.1:${port}/api/auth/google/start`, { redirect: 'manual' })
  assert.equal(googleStartResponse.status, 404)

  const { response: loginResponse, data: login } = await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  })
  assert.equal(loginResponse.status, 200, stderr)
  assert.equal(login.user.email, 'admin@demo.test')
  assert.equal(Object.hasOwn(login, 'token'), false)
  const adminCookie = extractSessionCookie(loginResponse)
  assert.ok(isSessionCookie(adminCookie))

  const { response: csrfResponse, data: csrf } = await jsonFetch(port, '/api/csrf', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(csrfResponse.status, 200)
  assert.ok(typeof csrf.csrfToken === 'string' && csrf.csrfToken.length > 10)
  assert.ok(typeof csrf.expiresAt === 'string' && csrf.expiresAt.length > 10)

  const { response: continuityResponse, data: continuitySession } = await jsonFetch(port, '/api/session', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(continuityResponse.status, 200)
  assert.equal(continuitySession.user.email, 'admin@demo.test')

  const authHeaders = {
    'Content-Type': 'application/json'
  }

  const { response: sessionResponse, data: session } = await jsonFetch(port, '/api/session', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(sessionResponse.status, 200)
  assert.equal(session.user.role, 'admin')

  const { response: createResponse, data: profile } = await jsonFetch(port, '/api/profiles', {
    method: 'POST',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Jordan',
      lastName: 'Contract',
      email: 'jordan.contract@example.com',
      stage: 'discovery',
      source: {
        cityOrLocation: 'Dallas',
        venue: 'Planning Workshop',
        occurredOn: '2026-03-23'
      }
    })
  })
  assert.equal(createResponse.status, 201, JSON.stringify(profile))
  assert.equal(profile.stage, 'discovery')
  assert.equal(profile.source.displayValue, 'Dallas X Planning Workshop X 2026-03-23')

  const { response: moveResponse, data: moved } = await jsonFetch(port, `/api/profiles/${profile.id}/stage`, {
    method: 'PATCH',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({ stage: 'analysis' })
  })
  assert.equal(moveResponse.status, 200)
  assert.equal(moved.moved.stage, 'analysis')
  assert.ok(typeof moved.board.boardVersion === 'number')

  const { response: reorderResponse, data: reordered } = await jsonFetch(port, '/api/pipeline/reorder', {
    method: 'PATCH',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({
      profileId: profile.id,
      toStage: 'analysis',
      expectedVersion: moved.moved.pipelineVersion,
      expectedUpdatedAt: moved.moved.updatedAt,
      expectedBoardVersion: moved.board.boardVersion
    })
  })
  assert.equal(reorderResponse.status, 200)
  assert.ok(Number.isInteger(reordered.moved.orderIndex) && reordered.moved.orderIndex > 0)

  const { response: staleResponse, data: staleError } = await jsonFetch(port, '/api/pipeline/reorder', {
    method: 'PATCH',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({
      profileId: profile.id,
      toStage: 'analysis',
      expectedVersion: moved.moved.pipelineVersion,
      expectedUpdatedAt: moved.moved.updatedAt
    })
  })
  assert.equal(staleResponse.status, 409)
  assert.equal(staleError.error?.code, 'PIPELINE_ORDER_CONFLICT')
  assert.equal(staleError.error?.details?.expectedVersion, moved.moved.pipelineVersion)

  const { response: historyResponse, data: history } = await jsonFetch(
    port,
    `/api/profiles/${profile.id}/stage-history`,
    {
      headers: { Cookie: adminCookie }
    }
  )
  assert.equal(historyResponse.status, 200)
  assert.equal(history.at(-1).toStage, 'analysis')

  // Backward compat: WITHOUT limit/cursor query params the profiles list is
  // still a bare array — pagination is strictly opt-in.
  const { response: profilesResponse, data: profiles } = await jsonFetch(port, '/api/profiles?search=Contract', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(profilesResponse.status, 200)
  assert.ok(Array.isArray(profiles))
  assert.ok(profiles.some((entry) => entry.id === profile.id))

  // Opt-in pagination: a limit param switches to the { items, nextCursor }
  // envelope on profiles, households, form templates, and form submissions.
  const { response: pagedProfilesResponse, data: pagedProfiles } = await jsonFetch(
    port,
    '/api/profiles?search=Contract&limit=1',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(pagedProfilesResponse.status, 200)
  assert.ok(!Array.isArray(pagedProfiles))
  assert.ok(Array.isArray(pagedProfiles.items))
  assert.ok(Object.hasOwn(pagedProfiles, 'nextCursor'))
  assert.ok(pagedProfiles.items.some((entry) => entry.id === profile.id))

  const { response: legacyHouseholdsResponse, data: legacyHouseholds } = await jsonFetch(port, '/api/households', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(legacyHouseholdsResponse.status, 200)
  assert.ok(Array.isArray(legacyHouseholds), 'no-param households response stays a bare array')
  const { response: pagedHouseholdsResponse, data: pagedHouseholds } = await jsonFetch(
    port,
    '/api/households?limit=1',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(pagedHouseholdsResponse.status, 200)
  assert.ok(Array.isArray(pagedHouseholds.items))
  assert.ok(Object.hasOwn(pagedHouseholds, 'nextCursor'))

  const { response: legacyFormTemplatesResponse, data: legacyFormTemplates } = await jsonFetch(
    port,
    '/api/forms/templates',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(legacyFormTemplatesResponse.status, 200)
  assert.ok(Array.isArray(legacyFormTemplates), 'no-param form templates response stays a bare array')
  const { response: pagedFormTemplatesResponse, data: pagedFormTemplates } = await jsonFetch(
    port,
    '/api/forms/templates?limit=1',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(pagedFormTemplatesResponse.status, 200)
  assert.ok(Array.isArray(pagedFormTemplates.items))
  assert.ok(Object.hasOwn(pagedFormTemplates, 'nextCursor'))

  const { response: legacySubmissionsResponse, data: legacySubmissions } = await jsonFetch(
    port,
    '/api/forms/submissions',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(legacySubmissionsResponse.status, 200)
  assert.ok(Array.isArray(legacySubmissions), 'no-param submissions response stays a bare array')
  const { response: pagedSubmissionsResponse, data: pagedSubmissions } = await jsonFetch(
    port,
    '/api/forms/submissions?limit=1',
    { headers: { Cookie: adminCookie } }
  )
  assert.equal(pagedSubmissionsResponse.status, 200)
  assert.ok(Array.isArray(pagedSubmissions.items))
  assert.ok(Object.hasOwn(pagedSubmissions, 'nextCursor'))

  // Global search finds the created profile and stays firm-scoped via the
  // session; the client role is excluded by policy (asserted in unit tests).
  const { response: searchResponse, data: searchPayload } = await jsonFetch(port, '/api/search?q=Contract', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(searchResponse.status, 200)
  assert.ok(Array.isArray(searchPayload.results))
  assert.ok(searchPayload.results.some((entry) => entry.type === 'profile' && entry.id === profile.id))

  const { response: auditResponse, data: audit } = await jsonFetch(port, '/api/audit', {
    headers: { Cookie: adminCookie }
  })
  assert.equal(auditResponse.status, 200)
  assert.ok(audit.some((entry) => entry.entityId === profile.id && entry.action === 'pipeline.stage_changed'))

  const { response: templateCreateResponse, data: template } = await jsonFetch(port, '/api/templates', {
    method: 'POST',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({
      name: 'Contract Template',
      fileName: 'contract-template.pdf',
      blueprint: { sections: [{ title: 'Summary', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })
  assert.equal(templateCreateResponse.status, 201, JSON.stringify(template))

  const { response: templatePublishResponse } = await jsonFetch(port, `/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Contract test publish' })
  })
  assert.equal(templatePublishResponse.status, 200)

  const readonlyEmail = 'readonly.contract@demo.test'
  const readonlyPassword = 'ReadonlyPass123!'
  const { response: inviteResponse, data: invite } = await jsonFetch(port, '/api/invites', {
    method: 'POST',
    headers: { ...authHeaders, Cookie: adminCookie },
    body: JSON.stringify({ email: readonlyEmail, role: 'readonly' })
  })
  assert.equal(inviteResponse.status, 201, JSON.stringify(invite))

  const { response: acceptInviteResponse, data: readonlySession } = await jsonFetch(port, '/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: invite.token,
      firstName: 'Read',
      lastName: 'Only',
      password: readonlyPassword
    })
  })
  assert.equal(acceptInviteResponse.status, 200, JSON.stringify(readonlySession))
  assert.equal(Object.hasOwn(readonlySession, 'token'), false)
  const readonlyCookie = extractSessionCookie(acceptInviteResponse)
  assert.ok(isSessionCookie(readonlyCookie))

  const readonlyAuth = { Cookie: readonlyCookie }
  const { response: readonlyVersionsResponse, data: readonlyVersions } = await jsonFetch(
    port,
    `/api/templates/${template.id}/versions`,
    { headers: readonlyAuth }
  )
  assert.equal(readonlyVersionsResponse.status, 200, JSON.stringify(readonlyVersions))
  assert.ok(Array.isArray(readonlyVersions) && readonlyVersions.length >= 2)

  const { response: readonlyTransitionsResponse, data: readonlyTransitions } = await jsonFetch(
    port,
    `/api/templates/${template.id}/publish-transitions`,
    { headers: readonlyAuth }
  )
  assert.equal(readonlyTransitionsResponse.status, 200, JSON.stringify(readonlyTransitions))
  assert.ok(readonlyTransitions.some((entry) => entry.from === 'draft' && entry.to === 'published'))

  const outsiderEmail = `outside.${Date.now()}@demo.test`
  const outsiderPassword = 'OutsidePass123!'
  const { response: outsiderRegisterResponse, data: outsider } = await jsonFetch(port, '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firmName: 'Outside Advisory',
      firstName: 'Outside',
      lastName: 'Admin',
      email: outsiderEmail,
      password: outsiderPassword
    })
  })
  assert.equal(outsiderRegisterResponse.status, 201, JSON.stringify(outsider))
  assert.equal(Object.hasOwn(outsider, 'token'), false)
  const outsiderCookie = extractSessionCookie(outsiderRegisterResponse)
  assert.ok(isSessionCookie(outsiderCookie))

  const outsiderAuth = { Cookie: outsiderCookie }
  const { response: outsiderVersionsResponse } = await jsonFetch(port, `/api/templates/${template.id}/versions`, {
    headers: outsiderAuth
  })
  assert.equal(outsiderVersionsResponse.status, 404)

  const { response: outsiderTransitionsResponse } = await jsonFetch(
    port,
    `/api/templates/${template.id}/publish-transitions`,
    { headers: outsiderAuth }
  )
  assert.equal(outsiderTransitionsResponse.status, 404)
})
