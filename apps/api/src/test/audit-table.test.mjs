import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { LATEST_SCHEMA_VERSION, migrations, runMigrations } from '../migrations/index.mjs'

const repoRoot = process.cwd()

// audit_events is the append-only source of truth: addAudit inserts canonical
// events directly into the table, the blob serializes auditEvents: [] for
// shape compatibility, and all readers (listAudit, dashboard, analytics) are
// firm-scoped SQL queries.
process.env.APP_SECRET = 'test-secret-audit-table'
process.env.AUTH_PROVIDER = 'local'

// Cache-busted store plus the SHARED (non-cache-busted) storage module: the
// store's internal `import './storage.mjs'` resolves to the same instance, so
// table inspections here hit the same database the store writes.
async function loadStoreWithSharedStorage() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-audit-table-'))
  process.chdir(tempDir)
  try {
    const storage = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href)
    const storeModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    )
    return { storage, storeModule }
  } finally {
    process.chdir(previousCwd)
  }
}

function readBlobPayload(dbPath) {
  const inspect = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get()?.payload || null
  } finally {
    inspect.close()
  }
}

test('migration: legacy blob audit events are backfilled into the table and cleared from the blob', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-audit-migration-legacy-'))
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const dbPath = join(tempDir, 'data', 'app.db')

  const nowIso = new Date().toISOString()
  const legacyEvents = [
    // Canonical shape.
    {
      id: 'audit-canonical-1',
      actor: { userId: 'user-1' },
      firmId: 'firm-1',
      entityType: 'profile',
      entityId: 'profile-1',
      action: 'profile.created',
      before: null,
      after: { kind: 'client' },
      timestamp: nowIso
    },
    // Pre-canonical legacy shape (occurredAt/metadata) without an id.
    {
      firmId: 'firm-1',
      actorUserId: 'user-1',
      entityType: 'note',
      entityId: 'note-1',
      action: 'profile.note_added',
      metadata: { profileId: 'profile-1' },
      occurredAt: nowIso
    }
  ]

  const legacyDb = new DatabaseSync(dbPath)
  try {
    migrations[0].up(legacyDb)
    legacyDb.exec('PRAGMA user_version = 1')
    legacyDb
      .prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))")
      .run(JSON.stringify({ firms: [], users: [], auditEvents: legacyEvents }))

    const result = runMigrations(legacyDb)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)
    assert.ok(LATEST_SCHEMA_VERSION >= 4, 'audit source-of-truth migration must advance the schema version')

    const rows = legacyDb.prepare('SELECT id, firm_id, action, payload FROM audit_events ORDER BY rowid').all()
    assert.equal(rows.length, 2, 'both legacy blob events must land in the table')
    assert.equal(rows[0].id, 'audit-canonical-1')
    assert.equal(rows[0].firm_id, 'firm-1')
    assert.equal(rows[0].action, 'profile.created')
    assert.ok(rows[1].id, 'id-less legacy event must get a generated id')
    assert.equal(rows[1].action, 'profile.note_added')
    assert.equal(JSON.parse(rows[1].payload).metadata.profileId, 'profile-1')

    const blob = JSON.parse(legacyDb.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
    assert.deepEqual(blob.auditEvents, [], 'blob auditEvents must be cleared after migration')

    // Idempotency: re-running the backfill must not duplicate rows.
    migrations.find((migration) => migration.version === 4).up(legacyDb)
    assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2)
  } finally {
    legacyDb.close()
  }
})

test('store: sensitive actions land as canonical events in audit_events; blob stays empty', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const user = store.requireUser(session.token)
  const created = store.createProfile(user, {
    kind: 'client',
    firstName: 'Audit',
    lastName: 'Table',
    ssn: '999-88-7777',
    taxId: '11-2223333'
  })
  store.getMaskedSensitiveData(user, created.id, { purpose: 'servicing' })

  // Canonical event in the table, scoped to the firm.
  const events = store.listAudit(user)
  const sensitiveRead = events.find((entry) => entry.action === 'sensitive.read' && entry.entityId === created.id)
  assert.ok(sensitiveRead, 'sensitive.read must be recorded in audit_events')
  assert.equal(sensitiveRead.firmId, user.firmId)
  assert.equal(sensitiveRead.actor.userId, user.id)
  assert.ok(sensitiveRead.timestamp)
  assert.ok(events.find((entry) => entry.action === 'auth.login.succeeded'))

  // Newest-first ordering (login happened before the sensitive read).
  const loginIndex = events.findIndex((entry) => entry.action === 'auth.login.succeeded')
  const readIndex = events.findIndex((entry) => entry.action === 'sensitive.read' && entry.entityId === created.id)
  assert.ok(readIndex < loginIndex, 'listAudit must return newest events first')

  // The blob no longer carries audit events.
  const blob = JSON.parse(readBlobPayload(storage.DB_PATH))
  assert.deepEqual(blob.auditEvents, [], 'app_state blob must serialize an empty auditEvents array')

  // Events survive a restart because the table is the source of truth.
  const restarted = storeModule.createStore()
  const restartedUser = restarted.requireUser(restarted.login({ email: 'admin@demo.test', password: 'ChangeMe123!' }).token)
  assert.ok(
    restarted
      .listAudit(restartedUser)
      .find((entry) => entry.action === 'sensitive.read' && entry.entityId === created.id),
    'audit events must survive a store restart'
  )
})

test('store: audit reads are firm-scoped', async () => {
  const { storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registeredA = store.register({
    firmName: `Scoped Firm A ${suffix}`,
    firstName: 'Ada',
    lastName: 'Alpha',
    email: `scoped.a.${suffix}@example.com`,
    password: 'ScopedFirmPass123'
  })
  const registeredB = store.register({
    firmName: `Scoped Firm B ${suffix}`,
    firstName: 'Bo',
    lastName: 'Beta',
    email: `scoped.b.${suffix}@example.com`,
    password: 'ScopedFirmPass123'
  })
  const userA = store.requireUser(registeredA.token)
  const userB = store.requireUser(registeredB.token)

  const profileA = store.createProfile(userA, { kind: 'prospect', firstName: 'Only', lastName: 'FirmA' })

  const eventsA = store.listAudit(userA)
  const eventsB = store.listAudit(userB)
  assert.ok(eventsA.find((entry) => entry.action === 'profile.created' && entry.entityId === profileA.id))
  assert.ok(eventsA.every((entry) => entry.firmId === userA.firmId), 'firm A reads only firm A events')
  assert.ok(eventsB.every((entry) => entry.firmId === userB.firmId), 'firm B reads only firm B events')
  assert.equal(
    eventsB.find((entry) => entry.entityId === profileA.id),
    undefined,
    'firm B must never see firm A audit rows'
  )

  // Dashboard recent events are scoped the same way.
  const dashboardB = store.getDashboard(userB)
  assert.ok(dashboardB.recentAuditEvents.every((entry) => entry.firmId === userB.firmId))
})

test('store: failed pipeline transaction does not leak audit rows', async () => {
  const { storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const user = store.requireUser(session.token)
  // profiles table is the source of truth: read through the store API.
  const prospect = store.listProfiles(user, 'prospect')[0]
  assert.ok(prospect)
  const targetStage = prospect.stage === 'analysis' ? 'discovery' : 'analysis'

  const countBefore = store.countAuditEvents()

  // Force the persist() inside executePipelineTransaction to fail AFTER the
  // mutator (and its addAudit calls) ran: buffered audit inserts must be
  // discarded along with the in-memory rollback.
  store.__setTestHooks({
    beforePersist: () => {
      throw new Error('forced persist failure for audit leak test')
    }
  })
  try {
    assert.throws(
      () => store.reorderBoard(user, { profileId: prospect.id, toStage: targetStage }),
      /forced persist failure/
    )
  } finally {
    store.__clearTestHooks()
  }

  assert.equal(
    store.countAuditEvents(),
    countBefore,
    'a failed pipeline transaction must not insert any audit rows'
  )
  assert.equal(
    store.listAudit(user).find((entry) => entry.action === 'pipeline.stage_changed' && entry.entityId === prospect.id),
    undefined
  )

  // And the same transaction succeeds (with audit rows) once persist works.
  const moved = store.reorderBoard(user, { profileId: prospect.id, toStage: targetStage })
  assert.equal(moved.moved.stage, targetStage)
  assert.ok(store.countAuditEvents() > countBefore)
  assert.ok(
    store.listAudit(user).find((entry) => entry.action === 'pipeline.stage_changed' && entry.entityId === prospect.id),
    'successful pipeline transaction must record its audit events'
  )
})
