import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { LATEST_SCHEMA_VERSION } from '../migrations/index.mjs'
import { createStore } from '../store.mjs'
import { createModules } from '../modules/index.mjs'

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

function freshStorageDir() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-notifications-'))
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  return tempDir
}

function createReads() {
  return {
    listProfiles: () => [],
    getProfileDetail: () => null,
    readMaterializedSummary: () => null
  }
}

test('migration 011 creates the notifications table at the latest schema version', async () => {
  const storage = await loadStorage(freshStorageDir())
  try {
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      assert.equal(Number(inspect.prepare('PRAGMA user_version').get().user_version), LATEST_SCHEMA_VERSION)
      const table = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
        .get()
      assert.equal(table?.name, 'notifications')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

test('notification repo: firm+user scoping, firm-wide fan-out, unread count, and idempotent mark-read', async () => {
  const storage = await loadStorage(freshStorageDir())
  try {
    // firm-a / user-1 personal, firm-a firm-wide (userId null), firm-a / user-2,
    // and a firm-b notification that must never leak into firm-a reads.
    storage.insertNotification({ id: 'n1', firmId: 'firm-a', userId: 'user-1', type: 'export.completed', title: 'A1' })
    storage.insertNotification({ id: 'n2', firmId: 'firm-a', userId: null, type: 'system', title: 'Firmwide' })
    storage.insertNotification({ id: 'n3', firmId: 'firm-a', userId: 'user-2', type: 'export.failed', title: 'B1' })
    storage.insertNotification({ id: 'n4', firmId: 'firm-b', userId: 'user-1', type: 'export.completed', title: 'Other' })

    // user-1 sees their own + firm-wide, never user-2's or firm-b's.
    const user1 = storage.listNotificationsForUser({ firmId: 'firm-a', userId: 'user-1' })
    assert.deepEqual(user1.map((n) => n.id).sort(), ['n1', 'n2'])
    assert.equal(storage.countUnreadNotifications({ firmId: 'firm-a', userId: 'user-1' }), 2)

    // Cross-tenant isolation: firm-b's notification is invisible to firm-a.
    assert.equal(
      storage.listNotificationsForUser({ firmId: 'firm-a', userId: 'user-1' }).some((n) => n.id === 'n4'),
      false
    )

    // Payload round-trips (title merged from the JSON column).
    assert.equal(user1.find((n) => n.id === 'n1').title, 'A1')

    // Mark one read: idempotent, preserves the original timestamp, decrements count.
    assert.equal(storage.markNotificationRead('n1', { firmId: 'firm-a', userId: 'user-1' }), true)
    const afterRead = storage.listNotificationsForUser({ firmId: 'firm-a', userId: 'user-1' })
    const firstStamp = afterRead.find((n) => n.id === 'n1').readAt
    assert.ok(firstStamp)
    storage.markNotificationRead('n1', { firmId: 'firm-a', userId: 'user-1' })
    const rereadStamp = storage
      .listNotificationsForUser({ firmId: 'firm-a', userId: 'user-1' })
      .find((n) => n.id === 'n1').readAt
    assert.equal(rereadStamp, firstStamp, 're-marking must not overwrite the original read timestamp')
    assert.equal(storage.countUnreadNotifications({ firmId: 'firm-a', userId: 'user-1' }), 1)

    // unread=1 filter returns only the still-unread firm-wide notification.
    const unread = storage.listNotificationsForUser({ firmId: 'firm-a', userId: 'user-1', unreadOnly: true })
    assert.deepEqual(unread.map((n) => n.id), ['n2'])

    // A user cannot mark another user's personal notification read (scoping).
    assert.equal(storage.markNotificationRead('n3', { firmId: 'firm-a', userId: 'user-1' }), false)

    // Mark-all clears the remaining firm-wide unread for user-1.
    const cleared = storage.markAllNotificationsRead({ firmId: 'firm-a', userId: 'user-1' })
    assert.equal(cleared, 1)
    assert.equal(storage.countUnreadNotifications({ firmId: 'firm-a', userId: 'user-1' }), 0)
    // user-2 still has their own unread notification.
    assert.equal(storage.countUnreadNotifications({ firmId: 'firm-a', userId: 'user-2' }), 1)
  } finally {
    storage.closeDatabase()
  }
})

test('export lifecycle emits export.completed / export.failed notifications to the job owner', async () => {
  const storage = await loadStorage(freshStorageDir())
  try {
    // Completed job -> export.completed for the owner.
    storage.enqueueExportJob({ id: 'exp-ok', firmId: 'firm-a', createdByUserId: 'owner-1', type: 'pdf' })
    storage.markExportJobCompleted('exp-ok', { fileName: 'out.pdf' })
    const ownerNotes = storage.listNotificationsForUser({ firmId: 'firm-a', userId: 'owner-1' })
    const completed = ownerNotes.find((n) => n.type === 'export.completed')
    assert.ok(completed, 'a completion notification is created')
    assert.equal(completed.entityType, 'export_job')
    assert.equal(completed.entityId, 'exp-ok')
    assert.equal(completed.link, '/exports')

    // Permanent failure ('invalid') dead-letters -> export.failed for the owner.
    storage.enqueueExportJob({ id: 'exp-bad', firmId: 'firm-a', createdByUserId: 'owner-1', type: 'pdf' })
    storage.markExportJobFailed('exp-bad', 'invalid template input', { maxAttempts: 1 })
    const failed = storage
      .listNotificationsForUser({ firmId: 'firm-a', userId: 'owner-1' })
      .find((n) => n.type === 'export.failed')
    assert.ok(failed, 'a failure notification is created on a terminal failure')
    assert.equal(failed.entityId, 'exp-bad')
  } finally {
    storage.closeDatabase()
  }
})

test('notifications service scopes list/unread/mark to the requesting user', () => {
  const store = createStore()
  const modules = createModules({ store, reads: createReads() })
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(adminSession.token)

  const created = modules.notifications.create(admin, { type: 'system', title: 'Hello', body: 'World' })
  assert.ok(created.id)

  const listed = modules.notifications.list(admin)
  assert.equal(listed.ok, true)
  assert.ok(listed.notifications.some((n) => n.id === created.id))
  assert.ok(listed.unreadCount >= 1)

  const count = modules.notifications.unreadCount(admin)
  assert.equal(count.ok, true)
  assert.ok(count.count >= 1)

  const marked = modules.notifications.markRead(admin, created.id)
  assert.equal(marked.ok, true)

  // Marking a non-existent (or cross-user) id is a 404.
  assert.throws(() => modules.notifications.markRead(admin, 'does-not-exist'), (error) => error.statusCode === 404)

  const all = modules.notifications.markAllRead(admin)
  assert.equal(all.ok, true)
})
