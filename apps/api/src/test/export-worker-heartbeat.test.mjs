import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStorage() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-worker-heartbeat-'))
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const storage = await import(moduleUrl)
  process.chdir(previousCwd)
  return storage
}

test('export worker heartbeat exposes companion-worker policy diagnostics', async () => {
  const storage = await loadStorage()
  storage.recordExportWorkerHeartbeat('heartbeat-test-worker', {
    mode: 'companion',
    pollMs: 250,
    batchSize: 3,
    lastResult: { processed: 1 }
  })

  const heartbeat = storage.readExportWorkerHeartbeat({ staleAfterMs: 60_000 })
  assert.equal(heartbeat.workerMode, 'companion')
  assert.equal(heartbeat.manualProcessEndpointDeprecated, true)
  assert.equal(heartbeat.workerObservedRecently, true)
  assert.equal(heartbeat.workers[0].workerId, 'heartbeat-test-worker')
  assert.equal(heartbeat.workers[0].lastResult.processed, 1)

  const queueStatus = storage.readExportWorkerStatus()
  assert.equal(queueStatus.workerMode, 'companion')
  assert.equal(queueStatus.manualProcessEndpointDeprecated, true)
  assert.equal(queueStatus.workerObservedRecently, true)
  assert.equal(queueStatus.pendingWithoutWorker, false)

  storage.closeDatabase()
})
