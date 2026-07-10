import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { runMigrations } from '../migrations/index.mjs'

const repoRoot = process.cwd()

async function loadStorage(tempDir) {
  const previousCwd = process.cwd()
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const storage = await import(moduleUrl)
  process.chdir(previousCwd)
  return storage
}

function readBlob(dbPath) {
  const inspect = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = inspect.prepare('SELECT payload, updated_at AS updatedAt FROM app_state WHERE id = 1').get()
    return { payload: row?.payload || null, updatedAt: row?.updatedAt || null }
  } finally {
    inspect.close()
  }
}

function buildSeedState() {
  return {
    marker: 'seeded',
    firms: [{ id: 'firm-1', name: 'Queue Firm', slug: 'queue-firm' }],
    users: [
      {
        id: 'user-1',
        firmId: 'firm-1',
        email: 'admin@queue.test',
        role: 'admin',
        firstName: 'Ada',
        lastName: 'Admin'
      }
    ],
    profiles: [],
    households: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [
      {
        id: 'export-seeded',
        firmId: 'firm-1',
        clientId: null,
        type: 'pdf',
        status: 'completed',
        output: { fileName: 'seeded.json' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    notes: [],
    auditEvents: []
  }
}

test('export queue mutations never touch app_state and state mutations survive concurrent queue writes', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-export-queue-truth-'))
  const storage = await loadStorage(tempDir)
  try {
    const state = storage.loadState(buildSeedState)

    // Seed compatibility: the blob's exportJobs seeded the relational table.
    assert.deepEqual(
      storage.listExportQueueJobs().map((job) => job.id),
      ['export-seeded']
    )
    // The in-memory state and blob no longer carry a queue mirror.
    assert.deepEqual(state.exportJobs, [])
    const blobAfterLoad = readBlob(storage.DB_PATH)
    assert.deepEqual(JSON.parse(blobAfterLoad.payload).exportJobs, [])

    // Worker-style queue mutations (enqueue, lease, complete, fail, requeue)
    // must leave app_state byte-for-byte untouched.
    const enqueued = storage.enqueueExportJob({
      id: 'export-worker-1',
      firmId: 'firm-1',
      clientId: null,
      type: 'pdf'
    })
    storage.leaseExportJobs({ workerId: 'worker-test', limit: 5 })
    storage.markExportJobCompleted(enqueued.id, { fileName: 'done.json' })
    const failer = storage.enqueueExportJob({ id: 'export-worker-2', firmId: 'firm-1', type: 'pdf' })
    storage.leaseExportJobs({ workerId: 'worker-test', limit: 5 })
    storage.markExportJobFailed(failer.id, 'timeout while rendering', { workerId: 'worker-test' })
    storage.requeueExportJob(failer.id)

    const blobAfterQueueWrites = readBlob(storage.DB_PATH)
    assert.equal(
      blobAfterQueueWrites.payload,
      blobAfterLoad.payload,
      'queue mutations must not rewrite the app_state payload'
    )
    assert.equal(
      blobAfterQueueWrites.updatedAt,
      blobAfterLoad.updatedAt,
      'queue mutations must not bump the app_state timestamp'
    )

    // API-style state mutation interleaved with the queue writes above: the
    // profile must survive (no lost update) and never drag a queue mirror
    // back into the blob.
    state.profiles.push({
      id: 'profile-new',
      firmId: 'firm-1',
      kind: 'prospect',
      firstName: 'New',
      lastName: 'Profile',
      stage: 'discovery'
    })
    storage.saveState(state)
    storage.markExportJobCompleted(failer.id, { fileName: 'second.json' })

    const finalBlob = JSON.parse(readBlob(storage.DB_PATH).payload)
    assert.deepEqual(
      finalBlob.profiles.map((profile) => profile.id),
      ['profile-new'],
      'API state mutation must survive concurrent queue writes'
    )
    assert.deepEqual(finalBlob.exportJobs, [], 'blob must never contain a populated exportJobs mirror')

    // Export listing still reflects the queue accurately from the table.
    const jobsById = new Map(storage.listExportQueueJobs().map((job) => [job.id, job]))
    assert.equal(jobsById.size, 3)
    assert.equal(jobsById.get('export-worker-1').status, 'completed')
    assert.equal(jobsById.get('export-worker-1').output.fileName, 'done.json')
    assert.equal(jobsById.get('export-worker-2').status, 'completed')
    assert.equal(jobsById.get('export-seeded').status, 'completed')
  } finally {
    storage.closeDatabase()
  }
})

test('lifecycle updates are targeted export_jobs writes that preserve aging timestamps', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-export-lifecycle-update-'))
  const storage = await loadStorage(tempDir)
  try {
    storage.loadState(buildSeedState)
    const before = storage.getExportJob('export-seeded')

    const archived = storage.applyExportJobLifecycleUpdate('export-seeded', {
      output: { ...before.output, archivedAt: '2026-01-05T00:00:00.000Z' }
    })
    assert.equal(archived.status, 'completed')
    assert.equal(archived.output.archivedAt, '2026-01-05T00:00:00.000Z')
    assert.equal(archived.updatedAt, before.updatedAt, 'archive must not reset the retention aging clock')

    const purged = storage.applyExportJobLifecycleUpdate('export-seeded', {
      status: 'purged',
      output: { ...archived.output, purgedAt: '2026-01-08T00:00:00.000Z' }
    })
    assert.equal(purged.status, 'purged')
    assert.equal(purged.output.purgedAt, '2026-01-08T00:00:00.000Z')

    assert.equal(storage.applyExportJobLifecycleUpdate('missing-job', { status: 'purged' }), null)
  } finally {
    storage.closeDatabase()
  }
})

test('loadState seeds the queue exactly once from a legacy blob and clears the blob mirror', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-export-legacy-seed-'))
  mkdirSync(join(tempDir, 'data'), { recursive: true })

  // Legacy fixture: app_state blob carries exportJobs, export_jobs table empty.
  const legacyJob = {
    id: 'export-legacy',
    firmId: 'firm-legacy',
    clientId: 'client-legacy',
    type: 'pdf',
    status: 'queued',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z'
  }
  const legacyState = {
    marker: 'legacy-db',
    firms: [{ id: 'firm-legacy', name: 'Legacy Firm', slug: 'legacy-firm' }],
    exportJobs: [legacyJob]
  }
  const fixture = new DatabaseSync(join(tempDir, 'data', 'app.db'))
  try {
    runMigrations(fixture)
    fixture
      .prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))")
      .run(JSON.stringify(legacyState))
    assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM export_jobs').get().count, 0)
  } finally {
    fixture.close()
  }

  const storage = await loadStorage(tempDir)
  try {
    const state = storage.loadState(() => {
      throw new Error('seed factory must not run for an existing blob')
    })
    assert.equal(state.marker, 'legacy-db')
    assert.deepEqual(state.exportJobs, [])

    const jobs = storage.listExportQueueJobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].id, 'export-legacy')
    assert.equal(jobs[0].firmId, 'firm-legacy')
    assert.equal(jobs[0].status, 'queued')

    // The blob mirror is cleared after the one-time seed.
    assert.deepEqual(JSON.parse(readBlob(storage.DB_PATH).payload).exportJobs, [])

    // A second load must not duplicate the seeded job.
    const reloaded = storage.loadState(() => {
      throw new Error('seed factory must not run for an existing blob')
    })
    assert.equal(reloaded.marker, 'legacy-db')
    assert.equal(storage.listExportQueueJobs().length, 1)
  } finally {
    storage.closeDatabase()
  }
})
