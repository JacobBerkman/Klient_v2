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

// Verification mode stays on for the whole file: every session mutation in
// the store compares the sessions table against state.sessions and throws on
// divergence, so all flows below double as dual-write parity assertions.
process.env.SESSION_DUAL_WRITE_VERIFY = '1'
process.env.APP_SECRET = 'test-secret-session-dual-write'
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
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-session-dual-write-'))
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
    assert.ok(LATEST_SCHEMA_VERSION >= 2, 'sessions migration must advance the schema version')
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

test('migration: legacy database with blob sessions backfills the sessions table', () => {
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
    // Sparse legacy record: missing activity/expiry fields must be tolerated.
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

    const rows = legacyDb.prepare('SELECT token, user_id, idle_expires_at FROM sessions ORDER BY token').all()
    assert.deepEqual(
      rows.map((row) => row.token),
      ['legacy-token-1', 'legacy-token-2']
    )
    assert.equal(rows[0].user_id, 'user-1')
    assert.equal(rows[0].idle_expires_at, futureIso)
    assert.equal(rows[1].idle_expires_at, null)
  } finally {
    legacyDb.close()
  }
})

test('migration: tolerates a missing or empty app_state blob', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-sessions-migration-empty-'))
  const db = new DatabaseSync(join(tempDir, 'app.db'))
  try {
    migrations[0].up(db)
    db.exec('PRAGMA user_version = 1')
    // No app_state row at all: migration must still succeed with an empty table.
    const result = runMigrations(db)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0)
  } finally {
    db.close()
  }
})

test('storage: deleteExpiredSessions removes stale rows and returns their tokens', async () => {
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
    assert.deepEqual(deleted, ['expired-token'])
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

test('store: login creates a matching sessions table row (dual-write verified)', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  assert.ok(session.token)

  const memorySession = store.state.sessions.find((entry) => entry.token === session.token)
  const tableRow = storage.getSessionByToken(session.token)
  assert.ok(tableRow, 'sessions table must contain the new session')
  // node:sqlite rows are null-prototype objects; spread for deepEqual.
  assert.deepEqual({ ...tableRow }, {
    token: memorySession.token,
    userId: memorySession.userId,
    firmId: memorySession.firmId,
    createdAt: memorySession.createdAt,
    lastActivityAt: memorySession.lastActivityAt,
    expiresAt: memorySession.expiresAt,
    idleExpiresAt: memorySession.idleExpiresAt
  })
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

  // ...but the sessions table row and the in-memory session both advanced.
  const rowAfter = storage.getSessionByToken(session.token)
  assert.notEqual(rowAfter.lastActivityAt, rowBefore.lastActivityAt)
  assert.notEqual(rowAfter.idleExpiresAt, rowBefore.idleExpiresAt)
  const memorySession = store.state.sessions.find((entry) => entry.token === session.token)
  assert.equal(memorySession.lastActivityAt, rowAfter.lastActivityAt)
  assert.equal(memorySession.idleExpiresAt, rowAfter.idleExpiresAt)
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
  assert.equal(invalidated.length, 1)
  assert.equal(invalidated[0].token, session.token)
  assert.equal(invalidated[0].reason, 'logout')
  assert.equal(storage.readCsrfToken(session.token, csrfId), null, 'CSRF tokens for the session must be cleaned up')
})

test('store: prune deletes expired table rows and fires per-session cleanup', async () => {
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

  const memorySession = store.state.sessions.find((entry) => entry.token === session.token)
  memorySession.expiresAt = new Date(Date.now() - 1000).toISOString()

  assert.throws(() => store.requireUser(session.token), /Authentication required/)

  assert.equal(storage.getSessionByToken(session.token), null, 'prune must delete the sessions table row')
  const pruned = invalidated.find((info) => info.token === session.token)
  assert.ok(pruned, 'prune must fire the session-invalidation callback')
  assert.equal(pruned.reason, 'max_age_expired')
  assert.equal(storage.readCsrfToken(session.token, csrfId), null, 'CSRF tokens for the session must be cleaned up')
})

test('store: password reset revokes all user sessions from the table', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const email = `reset.dual.${Date.now()}@example.com`
  const registered = store.auth.register({
    firmName: 'Reset Dual Write Advisors',
    firstName: 'Riley',
    lastName: 'Session',
    email,
    password: 'ResetDualWrite123'
  })
  const sessionA = store.auth.login({ email, password: 'ResetDualWrite123' })
  const sessionB = store.auth.login({ email, password: 'ResetDualWrite123' })
  assert.ok(storage.getSessionByToken(registered.token))
  assert.ok(storage.getSessionByToken(sessionA.token))
  assert.ok(storage.getSessionByToken(sessionB.token))

  const reset = store.auth.requestReset({ email, ipAddress: '198.51.100.7' })
  const result = store.auth.resetPassword({ token: reset.token, password: 'ResetDualWrite456' })
  assert.equal(result.ok, true)
  assert.ok(result.revokedSessions >= 3)

  assert.equal(storage.getSessionByToken(registered.token), null)
  assert.equal(storage.getSessionByToken(sessionA.token), null)
  assert.equal(storage.getSessionByToken(sessionB.token), null)
})

test('store: session rotation stays in dual-write parity', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const rotated = store.rotateSession(session.token, 'privilege_transition')

  assert.ok(rotated.token)
  assert.notEqual(rotated.token, session.token)
  assert.equal(storage.getSessionByToken(session.token), null, 'rotated-out token must be deleted from the table')
  assert.ok(storage.getSessionByToken(rotated.token), 'rotated-in token must exist in the table')
})
