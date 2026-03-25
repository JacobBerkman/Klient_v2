import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
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

test('production Node server contract supports auth and profile workflows', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'klient-contract-'))
  const port = 3210 + Math.floor(Math.random() * 200)
  const server = spawn(process.execPath, [serverEntrypoint], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' },
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
  assert.equal(ready.querySummary.users, 1)

  const { response: loginResponse, data: login } = await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  })
  assert.equal(loginResponse.status, 200, stderr)
  assert.equal(login.user.email, 'admin@demo.test')

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.token}`
  }

  const { response: sessionResponse, data: session } = await jsonFetch(port, '/api/session', {
    headers: { Authorization: `Bearer ${login.token}` }
  })
  assert.equal(sessionResponse.status, 200)
  assert.equal(session.user.role, 'admin')

  const { response: createResponse, data: profile } = await jsonFetch(port, '/api/profiles', {
    method: 'POST',
    headers: authHeaders,
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
    headers: authHeaders,
    body: JSON.stringify({ stage: 'analysis' })
  })
  assert.equal(moveResponse.status, 200)
  assert.equal(moved.moved.stage, 'analysis')
  assert.ok(typeof moved.board.boardVersion === 'number')

  const { response: reorderResponse, data: reordered } = await jsonFetch(port, '/api/pipeline/reorder', {
    method: 'PATCH',
    headers: authHeaders,
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
    headers: authHeaders,
    body: JSON.stringify({
      profileId: profile.id,
      toStage: 'analysis',
      expectedVersion: moved.moved.pipelineVersion,
      expectedUpdatedAt: moved.moved.updatedAt
    })
  })
  assert.equal(staleResponse.status, 409)
  assert.equal(staleError.error?.code, 'PIPELINE_ORDER_CONFLICT')

  const { response: historyResponse, data: history } = await jsonFetch(
    port,
    `/api/profiles/${profile.id}/stage-history`,
    {
      headers: { Authorization: `Bearer ${login.token}` }
    }
  )
  assert.equal(historyResponse.status, 200)
  assert.equal(history.at(-1).toStage, 'analysis')

  const { response: profilesResponse, data: profiles } = await jsonFetch(port, '/api/profiles?search=Contract', {
    headers: { Authorization: `Bearer ${login.token}` }
  })
  assert.equal(profilesResponse.status, 200)
  assert.ok(profiles.some((entry) => entry.id === profile.id))

  const { response: auditResponse, data: audit } = await jsonFetch(port, '/api/audit', {
    headers: { Authorization: `Bearer ${login.token}` }
  })
  assert.equal(auditResponse.status, 200)
  assert.ok(audit.some((entry) => entry.entityId === profile.id && entry.action === 'pipeline.stage_changed'))
})
