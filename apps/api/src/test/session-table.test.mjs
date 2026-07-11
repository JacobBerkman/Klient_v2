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

// The sessions table is the sole source of truth: every session read
// (requireUser, prune, logout, rotation) hits the table, and the app_state
// blob serializes sessions: [] purely for shape compatibility.
process.env.APP_SECRET = 'test-secret-session-table'
process.env.AUTH_PROVIDER = 'local'

// Isolated (cache-busted) storage module with its own database in tempDir.
async function loadIsolatedStorage(tempDir) {
  const previousCwd = process.cwd()
  process.chdir(tempDir)
  try {
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    return await import(moduleUrl)
  } finally {
    process.chdir(previousCwd)
  }
}

// Cache-busted store plus the SHARED (non-cache-busted) storage module. The
// store's internal `import './storage.mjs'` resolves without a query string,
// so importing the same bare URL here returns the exact module instance the
// store writes through — table inspections hit the same database.
async function loadStoreWithSharedStorage() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-session-table-'))
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

test('migration: fresh database reaches latest user_version with a sessions table', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-migration-fresh-'))
  const storage = await loadIsolatedStorage(tempDir)
  try {
    assert.ok(LATEST_SCHEMA_VERSION >= 3, 'blob-session retirement must advance the schema version')
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      const userVersion = Number(inspect.prepare('PRAGMA user_version').get()?.user_version || 0)
      assert.equal(userVersion, LATEST_SCHEMA_VERSION)
      const tables = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
      assert.ok(tables.includes('sessions'), 'sessions table must exist after migration')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

test('migration: legacy blob sessions are backfilled, normalized, and cleared from the blob', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-migration-legacy-'))
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const dbPath = join(tempDir, 'data', 'app.db')

  const nowIso = new Date().toISOString()
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const legacySessions = [
    {
      token: 'legacy-token-1',
      userId: 'user-1',
      firmId: 'firm-1',
      createdAt: nowIso,
      lastActivityAt: nowIso,
      expiresAt: futureIso,
      idleExpiresAt: futureIso
    },
    // Sparse legacy record: missing activity/expiry fields must be filled with
    // defaults (the table is authoritative and NULL expiries read as expired).
    { token: 'legacy-token-2', userId: 'user-2', firmId: 'firm-1', createdAt: nowIso }
  ]

  // Simulate a deployed pre-sessions database: baseline schema applied and
  // stamped at version 1, sessions living only inside the app_state blob.
  const legacyDb = new DatabaseSync(dbPath)
  try {
    migrations[0].up(legacyDb)
    legacyDb.exec('PRAGMA user_version = 1')
    legacyDb
      .prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))")
      .run(JSON.stringify({ firms: [], users: [], sessions: legacySessions }))

    const result = runMigrations(legacyDb)
    assert.equal(result.previousVersion, 1)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)

    const rows = legacyDb
      .prepare('SELECT token, user_id, expires_at, idle_expires_at, last_activity_at FROM sessions ORDER BY token')
      .all()
    assert.deepEqual(
      rows.map((row) => row.token),
      ['legacy-token-1', 'legacy-token-2']
    )
    // Explicit values survive untouched.
    assert.equal(rows[0].user_id, 'user-1')
    assert.equal(rows[0].idle_expires_at, futureIso)
    assert.equal(rows[0].expires_at, futureIso)
    // Sparse record got normalized defaults instead of NULLs.
    assert.ok(rows[1].expires_at, 'sparse legacy record must get an absolute expiry')
    assert.ok(rows[1].idle_expires_at, 'sparse legacy record must get an idle expiry')
    assert.equal(rows[1].last_activity_at, nowIso)

    // Migration 003 clears the retired sessions array out of the blob.
    const blob = JSON.parse(legacyDb.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
    assert.deepEqual(blob.sessions, [], 'blob sessions must be cleared after migration')
  } finally {
    legacyDb.close()
  }
})

test('migration: normalizes NULL expiry columns left by the pre-normalization 002 backfill', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-migration-nulls-'))
  const db = new DatabaseSync(join(tempDir, 'app.db'))
  try {
    // Simulate a database that already ran the ORIGINAL 002 backfill (raw
    // values, no normalization) and is stamped at version 2.
    migrations[0].up(db)
    db.exec(`
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY, user_id TEXT, firm_id TEXT, created_at TEXT,
        last_activity_at TEXT, expires_at TEXT, idle_expires_at TEXT
      )
    `)
    db.prepare('INSERT INTO sessions (token, user_id, firm_id, created_at) VALUES (?, ?, ?, ?)').run(
      'sparse-row',
      'user-1',
      'firm-1',
      new Date().toISOString()
    )
    db.exec('PRAGMA user_version = 2')

    runMigrations(db)

    const row = db
      .prepare('SELECT expires_at, idle_expires_at, last_activity_at FROM sessions WHERE token = ?')
      .get('sparse-row')
    assert.ok(row.expires_at, 'migration 003 must fill NULL expires_at')
    assert.ok(row.idle_expires_at, 'migration 003 must fill NULL idle_expires_at')
    assert.ok(row.last_activity_at, 'migration 003 must fill NULL last_activity_at')
  } finally {
    db.close()
  }
})

test('migration: tolerates a missing or empty app_state blob', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-migration-empty-'))
  const db = new DatabaseSync(join(tempDir, 'app.db'))
  try {
    migrations[0].up(db)
    db.exec('PRAGMA user_version = 1')
    // No app_state row at all: migrations must still succeed with an empty table.
    const result = runMigrations(db)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0)
  } finally {
    db.close()
  }
})

test('storage: deleteExpiredSessions removes stale rows and returns their full rows', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-expired-'))
  const storage = await loadIsolatedStorage(tempDir)
  try {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    storage.upsertSession({
      token: 'expired-token',
      userId: 'user-1',
      firmId: 'firm-1',
      createdAt: past,
      lastActivityAt: past,
      expiresAt: past,
      idleExpiresAt: past
    })
    storage.upsertSession({
      token: 'active-token',
      userId: 'user-2',
      firmId: 'firm-1',
      createdAt: past,
      lastActivityAt: past,
      expiresAt: future,
      idleExpiresAt: future
    })

    const deleted = storage.deleteExpiredSessions(new Date().toISOString())
    assert.deepEqual(
      deleted.map((row) => row.token),
      ['expired-token']
    )
    // Full row payload so callers can compute the invalidation reason.
    assert.equal(deleted[0].userId, 'user-1')
    assert.equal(deleted[0].firmId, 'firm-1')
    assert.equal(deleted[0].expiresAt, past)
    assert.equal(deleted[0].idleExpiresAt, past)
    assert.equal(storage.getSessionByToken('expired-token'), null)
    assert.equal(storage.getSessionByToken('active-token')?.token, 'active-token')
    assert.deepEqual(
      storage.listSessionsFromTable().map((row) => row.token),
      ['active-token']
    )
  } finally {
    storage.closeDatabase()
  }
})

test('store: login creates a sessions table row, auth works, and the blob carries no sessions', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  assert.ok(session.token)

  const tableRow = storage.getSessionByToken(session.token)
  assert.ok(tableRow, 'sessions table must contain the new session')
  assert.equal(tableRow.userId, session.user.id)
  assert.equal(tableRow.firmId, session.user.firmId)
  assert.ok(tableRow.expiresAt, 'session row must carry an absolute expiry')
  assert.ok(tableRow.idleExpiresAt, 'session row must carry an idle expiry')

  // Reads come from the table: requireUser authenticates against the row.
  const user = store.requireUser(session.token)
  assert.equal(user.email, 'admin@demo.test')

  // The blob never carries sessions anymore.
  const blob = JSON.parse(readBlobPayload(storage.DB_PATH))
  assert.deepEqual(blob.sessions, [], 'app_state blob must serialize an empty sessions array')
})

test('store: requireUser touch updates the table without rewriting the app_state blob', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const payloadBefore = readBlobPayload(storage.DB_PATH)
  const rowBefore = storage.getSessionByToken(session.token)
  assert.ok(payloadBefore)
  assert.ok(rowBefore)

  await delay(15)
  const user = store.requireUser(session.token)
  assert.equal(user.email, 'admin@demo.test')

  // The activity touch must NOT rewrite the blob: payload bytes unchanged.
  const payloadAfter = readBlobPayload(storage.DB_PATH)
  assert.equal(payloadAfter, payloadBefore, 'app_state payload must be byte-identical after a touch')

  // ...but the sessions table row advanced.
  const rowAfter = storage.getSessionByToken(session.token)
  assert.notEqual(rowAfter.lastActivityAt, rowBefore.lastActivityAt)
  assert.notEqual(rowAfter.idleExpiresAt, rowBefore.idleExpiresAt)
})

test('store: absolute expiry is enforced from table data and fires CSRF cleanup', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const invalidated = []
  const store = storeModule.createStore({
    onSessionInvalidated: (info) => {
      invalidated.push(info)
      storage.deleteCsrfTokensBySession(info.token)
    }
  })

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const csrfId = randomUUID()
  const issuedAt = new Date().toISOString()
  storage.upsertCsrfToken({
    id: csrfId,
    sessionToken: session.token,
    userId: 'admin-user',
    token: randomUUID(),
    issuedAt,
    lastRotatedAt: issuedAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  })

  // Force absolute expiry directly in the table (idle expiry stays valid).
  const row = storage.getSessionByToken(session.token)
  storage.upsertSession({ ...row, expiresAt: new Date(Date.now() - 1000).toISOString() })

  assert.throws(() => store.requireUser(session.token), /Authentication required/)

  assert.equal(storage.getSessionByToken(session.token), null, 'prune must delete the sessions table row')
  const pruned = invalidated.find((info) => info.token === session.token)
  assert.ok(pruned, 'prune must fire the session-invalidation callback')
  assert.equal(pruned.reason, 'max_age_expired')
  assert.equal(pruned.userId, row.userId)
  assert.equal(pruned.firmId, row.firmId)
  assert.equal(storage.readCsrfToken(session.token, csrfId), null, 'CSRF tokens for the session must be cleaned up')
})

test('store: idle expiry is enforced from table data with idle_timeout reason', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const invalidated = []
  const store = storeModule.createStore({
    onSessionInvalidated: (info) => invalidated.push(info)
  })

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })

  // Idle out the session while its absolute expiry is still in the future.
  const row = storage.getSessionByToken(session.token)
  storage.upsertSession({ ...row, idleExpiresAt: new Date(Date.now() - 1000).toISOString() })

  assert.throws(() => store.requireUser(session.token), /Authentication required/)
  assert.equal(storage.getSessionByToken(session.token), null)
  const pruned = invalidated.find((info) => info.token === session.token)
  assert.ok(pruned)
  assert.equal(pruned.reason, 'idle_timeout')
})

test('store: logout deletes the table row and fires CSRF cleanup', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const invalidated = []
  const store = storeModule.createStore({
    onSessionInvalidated: (info) => {
      invalidated.push(info)
      storage.deleteCsrfTokensBySession(info.token)
    }
  })

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const csrfId = randomUUID()
  const issuedAt = new Date().toISOString()
  storage.upsertCsrfToken({
    id: csrfId,
    sessionToken: session.token,
    userId: 'admin-user',
    token: randomUUID(),
    issuedAt,
    lastRotatedAt: issuedAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  })

  store.logout(session.token)

  assert.equal(storage.getSessionByToken(session.token), null, 'logout must delete the sessions table row')
  const loggedOut = invalidated.find((info) => info.token === session.token)
  assert.ok(loggedOut)
  assert.equal(loggedOut.reason, 'logout')
  assert.equal(storage.readCsrfToken(session.token, csrfId), null, 'CSRF tokens for the session must be cleaned up')
})

test('store: password reset revokes all user sessions from the table', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const email = `reset.table.${Date.now()}@example.com`
  const registered = store.auth.register({
    firmName: 'Reset Table Advisors',
    firstName: 'Riley',
    lastName: 'Session',
    email,
    password: 'ResetTableWrite123'
  })
  const sessionA = store.auth.login({ email, password: 'ResetTableWrite123' })
  const sessionB = store.auth.login({ email, password: 'ResetTableWrite123' })
  assert.ok(storage.getSessionByToken(registered.token))
  assert.ok(storage.getSessionByToken(sessionA.token))
  assert.ok(storage.getSessionByToken(sessionB.token))

  const reset = store.auth.requestReset({ email, ipAddress: '198.51.100.7' })
  const result = store.auth.resetPassword({ token: reset.token, password: 'ResetTableWrite456' })
  assert.equal(result.ok, true)
  assert.ok(result.revokedSessions >= 3)

  assert.equal(storage.getSessionByToken(registered.token), null)
  assert.equal(storage.getSessionByToken(sessionA.token), null)
  assert.equal(storage.getSessionByToken(sessionB.token), null)
  assert.throws(() => store.requireUser(sessionA.token), /Authentication required/)
  const login = store.auth.login({ email, password: 'ResetTableWrite456' })
  assert.equal(store.requireUser(login.token).email, email)
})

test('store: invite acceptance creates a working table-backed session', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const admin = store.requireUser(store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' }).token)
  const invite = store.inviteUser(admin, { email: `invitee.${Date.now()}@example.com`, role: 'advisor' })
  const accepted = store.acceptInvite({
    token: invite.token,
    firstName: 'Ivy',
    lastName: 'Invitee',
    password: 'InviteeStrong123'
  })

  assert.ok(storage.getSessionByToken(accepted.token), 'accepted invite must create a sessions table row')
  assert.equal(store.requireUser(accepted.token).email, invite.email)
})

test('store: session rotation swaps table rows', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const rotated = store.rotateSession(session.token, 'privilege_transition')

  assert.ok(rotated.token)
  assert.notEqual(rotated.token, session.token)
  assert.equal(storage.getSessionByToken(session.token), null, 'rotated-out token must be deleted from the table')
  assert.ok(storage.getSessionByToken(rotated.token), 'rotated-in token must exist in the table')
  assert.equal(store.requireUser(rotated.token).email, 'admin@demo.test')
})

test('store: restart preserves table session activity (no blob reconciliation clobber)', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  await delay(15)
  // Advance activity: the touch lands ONLY in the sessions table.
  store.requireUser(session.token)
  const rowBefore = storage.getSessionByToken(session.token)
  assert.ok(rowBefore)

  // Simulate a server restart: a fresh store boots from the same database.
  // The old startup reconciliation (replaceSessions) used to rewrite the
  // table from stale blob values, clobbering fresh activity timestamps; with
  // the blob mirror retired, boot must leave session rows byte-identical.
  const restarted = storeModule.createStore()
  const rowAfter = storage.getSessionByToken(session.token)
  assert.deepEqual({ ...rowAfter }, { ...rowBefore }, 'restart must not rewrite session rows')

  // And the session still authenticates on the restarted store.
  assert.equal(restarted.requireUser(session.token).email, 'admin@demo.test')
})

test('store: a backfilled legacy session row authenticates against the table', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  // Insert a row shaped exactly like the 002 backfill produces for a sparse
  // legacy blob record (normalized defaults), keyed to a real seeded user.
  const adminUser = store.state.users.find((entry) => entry.email === 'admin@demo.test')
  assert.ok(adminUser)
  const createdAt = new Date().toISOString()
  const token = `legacy-backfilled-${randomUUID()}`
  storage.upsertSession({
    token,
    userId: adminUser.id,
    firmId: adminUser.firmId,
    createdAt,
    lastActivityAt: createdAt,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 8).toISOString(),
    idleExpiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString()
  })

  assert.equal(store.requireUser(token).email, 'admin@demo.test')
  store.logout(token)
  assert.equal(storage.getSessionByToken(token), null)
})
