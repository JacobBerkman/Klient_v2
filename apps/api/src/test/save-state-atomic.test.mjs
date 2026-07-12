import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

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

function buildGoodState() {
  return {
    marker: 'pre-failure',
    // firms/users/households are deliberately absent from the derived-table
    // sync since migration 009 (relational sources of truth); rows are written
    // via upsertFirmRow / upsertUserRow below instead.
    firms: [],
    users: [],
    households: [],
    // profiles is likewise a source of truth (migration 006), written via
    // upsertProfileRow below.
    profiles: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [],
    notes: [],
    auditEvents: []
  }
}

test('saveState is atomic: a failure mid-sync rolls back the blob and derived tables', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-save-state-atomic-'))
  const storage = await loadStorage(tempDir)
  try {
    const goodState = buildGoodState()
    storage.saveState(goodState)
    // firms/users/households/profiles are sources of truth written via targeted
    // upserts, not by saveState — seed rows to prove the failed save leaves them
    // alone.
    storage.upsertFirmRow({ id: 'firm-1', name: 'Atomic Firm', slug: 'atomic-firm' })
    storage.upsertUserRow({
      id: 'user-1',
      firmId: 'firm-1',
      email: 'admin@atomic.test',
      role: 'admin',
      firstName: 'Ada',
      lastName: 'Admin'
    })
    storage.upsertProfileRow({
      id: 'profile-1',
      firmId: 'firm-1',
      kind: 'prospect',
      firstName: 'Pat',
      lastName: 'Prospect',
      stage: 'discovery'
    })
    // Re-save so the materialized analytics pick up the upserted firm row.
    storage.saveState(goodState)

    // Corrupt a firms row's payload to invalid JSON. saveState no longer
    // projects derived query tables (syncQueryTables / replaceRows were retired
    // once the template system became relational); the only in-transaction work
    // left after the app_state blob upsert is the materialized-analytics
    // rebuild, which reads the firms table via listFirmRows -> JSON.parse. The
    // corrupt payload makes that parse throw AFTER the blob upsert has already
    // executed inside the same transaction, so runInTransaction must roll the
    // blob back. Without the transaction the blob would survive the failure.
    const corrupt = new DatabaseSync(storage.DB_PATH)
    try {
      corrupt.prepare('UPDATE firms SET payload = ? WHERE id = ?').run('{not-valid-json', 'firm-1')
    } finally {
      corrupt.close()
    }

    const corruptState = { ...goodState, marker: 'post-failure' }
    assert.throws(() => storage.saveState(corruptState))

    const inspect = new DatabaseSync(storage.DB_PATH)
    try {
      const blob = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.equal(blob.marker, 'pre-failure', 'app_state blob must still reflect the pre-failure state')
      // firms are stripped from the blob (source-of-truth table now).
      assert.deepEqual(blob.firms, [])

      const firmRows = inspect
        .prepare('SELECT id, name FROM firms ORDER BY id')
        .all()
        .map((row) => ({ id: row.id, name: row.name }))
      assert.deepEqual(firmRows, [{ id: 'firm-1', name: 'Atomic Firm' }], 'saveState must never clobber the firms table')

      const userRows = inspect
        .prepare('SELECT id FROM users ORDER BY id')
        .all()
        .map((row) => row.id)
      assert.deepEqual(userRows, ['user-1'], 'saveState must never clobber the users table')

      const profileRows = inspect
        .prepare('SELECT id FROM profiles ORDER BY id')
        .all()
        .map((row) => row.id)
      assert.deepEqual(profileRows, ['profile-1'], 'saveState must never clobber the relational profiles table')

      const analyticsRows = inspect
        .prepare('SELECT firm_id FROM analytics_materialized ORDER BY firm_id')
        .all()
        .map((row) => row.firm_id)
      assert.deepEqual(analyticsRows, ['firm-1'])
    } finally {
      inspect.close()
    }

    // Repair the corrupt firm payload so the analytics rebuild can parse it
    // again; the point under test (transactional rollback) is already proven.
    const repair = new DatabaseSync(storage.DB_PATH)
    try {
      repair
        .prepare('UPDATE firms SET payload = ? WHERE id = ?')
        .run(JSON.stringify({ id: 'firm-1', name: 'Atomic Firm', slug: 'atomic-firm' }), 'firm-1')
    } finally {
      repair.close()
    }

    // The connection must be usable again after the rollback: a subsequent
    // valid save commits normally.
    const nextState = { ...goodState, marker: 'after-rollback' }
    storage.saveState(nextState)
    const reloaded = storage.loadState(() => {
      throw new Error('seed factory must not run when a blob exists')
    })
    assert.equal(reloaded.marker, 'after-rollback')
  } finally {
    storage.closeDatabase()
  }
})

test('saveState commits blob, query tables, and analytics together on success', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-save-state-commit-'))
  const storage = await loadStorage(tempDir)
  try {
    storage.saveState(buildGoodState())
    // firms is a source of truth: the table stays empty until a targeted upsert
    // writes a row, so seed one then re-save to materialize its analytics.
    storage.upsertFirmRow({ id: 'firm-1', name: 'Atomic Firm', slug: 'atomic-firm' })
    storage.saveState(buildGoodState())
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      const blob = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.equal(blob.marker, 'pre-failure')
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM firms').get().count, 1)
      // profiles is no longer projected by saveState: the table stays empty
      // until a targeted upsert writes a row.
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 0)
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM analytics_materialized').get().count, 1)
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})
