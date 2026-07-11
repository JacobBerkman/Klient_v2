import baseline from './001-baseline.mjs'
import sessionsTable from './002-sessions.mjs'
import retireBlobSessions from './003-retire-blob-sessions.mjs'
import auditEventsSourceOfTruth from './004-audit-events-source-of-truth.mjs'

// Ordered list of schema migrations. Each entry is { version, name, up(db) }.
// Versions must be positive, unique, ascending integers; the applied version
// is tracked via PRAGMA user_version.
export const migrations = [baseline, sessionsTable, retireBlobSessions, auditEventsSourceOfTruth]

function assertMigrationList(list) {
  let previousVersion = 0
  for (const migration of list) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error(
        `Migration versions must be ascending positive integers; got ${migration.version} (${migration.name}) after ${previousVersion}.`
      )
    }
    if (typeof migration.up !== 'function') {
      throw new Error(`Migration ${migration.version} (${migration.name}) is missing an up(db) function.`)
    }
    previousVersion = migration.version
  }
}

export function getCurrentSchemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get()
  return Number(row?.user_version || 0)
}

export const LATEST_SCHEMA_VERSION = migrations.length ? migrations[migrations.length - 1].version : 0

export function runMigrations(db) {
  assertMigrationList(migrations)
  const previousVersion = getCurrentSchemaVersion(db)
  const applied = []
  for (const migration of migrations) {
    if (migration.version <= previousVersion) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      // PRAGMA assignments cannot be parameterized; version is a validated integer.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    applied.push({ version: migration.version, name: migration.name })
  }
  return {
    previousVersion,
    currentVersion: getCurrentSchemaVersion(db),
    applied
  }
}
