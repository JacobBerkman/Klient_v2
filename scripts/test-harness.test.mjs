import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createTestContext } from './test-harness.mjs'

function createFakeManagedProcess(pid = 4321) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.exitCode = child.exitCode ?? 0
    return true
  }
  return {
    child,
    label: `fake-${pid}`,
    startedAt: Date.now(),
    stdoutTail: 'boot stdout',
    stderrTail: 'boot stderr',
    detached: false
  }
}

function makeJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('createTestContext rejects a foreign ready responder on the deterministic port', async () => {
  const managed = createFakeManagedProcess(6101)
  let terminated = false
  let removed = false

  await assert.rejects(
    () =>
      createTestContext('exports', {
        testContextId: 'test-context-exports-expected',
        startProcess: () => managed,
        terminateProcess: async () => {
          terminated = true
          managed.child.exitCode = 1
          return { exited: true }
        },
        fetchImpl: async (url) => {
          if (String(url).endsWith('/ready')) {
            return makeJsonResponse({
              status: 'ready',
              instanceId: 'foreign-server',
              pid: 9999,
              bootedAt: '2026-04-23T00:00:00.000Z'
            })
          }
          throw new Error(`unexpected url ${url}`)
        },
        mkdtempImpl: async () => 'C:\\fake-suite',
        rmImpl: async () => {
          removed = true
        },
        releaseStdio: () => {},
        waitImpl: async () => {}
      }),
    /Foreign responder detected/
  )

  assert.equal(terminated, true)
  assert.equal(removed, true)
})

test('createTestContext fails fast when the spawned server exits during startup', async () => {
  const managed = createFakeManagedProcess(6102)
  let waitCalls = 0

  await assert.rejects(
    () =>
      createTestContext('templates', {
        testContextId: 'test-context-templates-expected',
        startProcess: () => managed,
        terminateProcess: async () => ({ exited: true }),
        fetchImpl: async () => {
          const error = new Error('connect refused')
          error.code = 'ECONNREFUSED'
          throw error
        },
        mkdtempImpl: async () => 'C:\\fake-suite',
        rmImpl: async () => {},
        releaseStdio: () => {},
        waitImpl: async () => {
          waitCalls += 1
          if (waitCalls === 1) {
            managed.child.exitCode = 98
            managed.child.emit('exit', 98, null)
          }
        }
      }),
    /Server exited before startup completed/
  )
})

test('context request errors include server exit diagnostics after startup', async () => {
  const managed = createFakeManagedProcess(6103)
  let startupComplete = false
  const context = await createTestContext('smoke', {
    testContextId: 'test-context-smoke-expected',
    startProcess: () => managed,
    terminateProcess: async () => ({ exited: true }),
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.endsWith('/ready')) {
        return makeJsonResponse({
          status: 'ready',
          instanceId: 'test-context-smoke-expected',
          pid: 6103,
          bootedAt: '2026-04-23T00:00:00.000Z'
        })
      }
      if (!startupComplete) throw new Error(`unexpected startup url ${target}`)
      const error = new Error('socket closed')
      error.code = 'ECONNRESET'
      throw error
    },
    mkdtempImpl: async () => 'C:\\fake-suite',
    rmImpl: async () => {},
    releaseStdio: () => {},
    waitImpl: async () => {},
    waitForUnavailable: async () => true
  })

  startupComplete = true
  managed.child.exitCode = 1
  managed.child.emit('exit', 1, null)

  await assert.rejects(
    () => context.request('/api/exports', { headers: { 'Content-Type': 'application/json' } }),
    /Request transport failed after suite server exited/
  )

  await context.shutdown()
})
