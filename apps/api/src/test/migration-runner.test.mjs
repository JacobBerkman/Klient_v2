import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { LATEST_SCHEMA_VERSION, migrations, runMigrations } from '../migrations/index.mjs'

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

const EXPECTED_TABLES = [
  'app_state',
  'firms',
  'users',
  'profiles',
  'households',
  'form_templates',
  'document_templates',
  'template_aggregates',
  'export_jobs',
  'notes',
  'audit_events',
  'analytics_materialized',
  'csrf_tokens',
  'export_worker_heartbeats'
]

test('migration runner: fresh database reaches latest user_version with expected schema in WAL mode', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-migration-runner-'))
  const storage = await loadStorage(tempDir)
  try {
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      const userVersion = Number(inspect.prepare('PRAGMA user_version').get()?.user_version || 0)
      assert.equal(userVersion, LATEST_SCHEMA_VERSION)
      assert.equal(LATEST_SCHEMA_VERSION, migrations[migrations.length - 1].version)

      const tableNames = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      for (const table of EXPECTED_TABLES) {
        assert.ok(tableNames.includes(table), `expected table ${table} to exist`)
      }

      // journal_mode = WAL is persisted in the database file, so even a fresh
      // read-only connection must observe it.
      assert.equal(inspect.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

test('migration runner: re-running runMigrations is a no-op', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-migration-rerun-'))
  const db = new DatabaseSync(join(tempDir, 'app.db'))
  try {
    const first = runMigrations(db)
    assert.equal(first.previousVersion, 0)
    assert.equal(first.currentVersion, LATEST_SCHEMA_VERSION)
    assert.equal(first.applied.length, migrations.length)

    const columnCountBefore = db.prepare('PRAGMA table_info(profiles)').all().length

    const second = runMigrations(db)
    assert.equal(second.previousVersion, LATEST_SCHEMA_VERSION)
    assert.equal(second.currentVersion, LATEST_SCHEMA_VERSION)
    assert.equal(second.applied.length, 0)
    assert.equal(db.prepare('PRAGMA table_info(profiles)').all().length, columnCountBefore)
  } finally {
    db.close()
  }
})

test('migration runner: baseline is idempotent on a pre-existing user_version 0 database', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-migration-legacy-'))
  const db = new DatabaseSync(join(tempDir, 'app.db'))
  try {
    // Simulate an already-deployed database created before versioned
    // migrations existed: schema present, user_version still 0.
    for (const migration of migrations) {
      migration.up(db)
    }
    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version || 0), 0)
    db.prepare('INSERT INTO firms (id, name, slug, payload) VALUES (?, ?, ?, ?)').run(
      'firm-legacy',
      'Legacy Firm',
      'legacy-firm',
      '{}'
    )

    const result = runMigrations(db)
    assert.equal(result.previousVersion, 0)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM firms').get().count, 1)
  } finally {
    db.close()
  }
})

test('migration runner: WAL-safe backup passes quick_check and round-trips through restore', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'klient-backup-source-'))
  const restoreDir = mkdtempSync(join(tmpdir(), 'klient-backup-restore-'))
  const backupPath = join(sourceDir, 'backup-roundtrip.db')

  const storage = await loadStorage(sourceDir)
  try {
    const state = storage.loadState(() => ({ marker: 'backup-roundtrip', firms: [], users: [], profiles: [] }))
    assert.equal(state.marker, 'backup-roundtrip')

    const result = storage.backupState(backupPath)
    assert.equal(result.ok, true)
    assert.equal(result.targetPath, resolve(backupPath))

    const backupDb = new DatabaseSync(backupPath, { readOnly: true })
    try {
      assert.equal(backupDb.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    } finally {
      backupDb.close()
    }
  } finally {
    storage.closeDatabase()
  }

  // Restore: copy the backup into a fresh data dir (clearing any stale WAL
  // sidecars, mirroring scripts/restore-db.mjs) and boot storage on top of it.
  const restoredDbPath = join(restoreDir, 'data', 'app.db')
  mkdirSync(join(restoreDir, 'data'), { recursive: true })
  rmSync(`${restoredDbPath}-wal`, { force: true })
  rmSync(`${restoredDbPath}-shm`, { force: true })
  copyFileSync(backupPath, restoredDbPath)

  const restoredStorage = await loadStorage(restoreDir)
  try {
    const restoredState = restoredStorage.loadState(() => ({ marker: 'seed-should-not-run' }))
    assert.equal(restoredState.marker, 'backup-roundtrip')
  } finally {
    restoredStorage.closeDatabase()
  }
})
