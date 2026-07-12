import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.APP_SECRET = 'test-secret-activity-feed'
process.env.AUTH_PROVIDER = 'local'

const repoRoot = process.cwd()

// Shared (non-cache-busted) storage + cache-busted store, so direct
// storage.insertAuditEvent writes land in the same database the store (and the
// activity service through it) reads. Mirrors audit-table.test.mjs.
async function loadStack() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-activity-'))
  process.chdir(tempDir)
  try {
    const storage = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href)
    const storeModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    )
    const modulesModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/modules/index.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    )
    const store = storeModule.createStore()
    const modules = modulesModule.createModules({
      store,
      reads: { listProfiles: () => [], getProfileDetail: () => null, readMaterializedSummary: () => null }
    })
    return { storage, store, modules }
  } finally {
    process.chdir(previousCwd)
  }
}

function registerFirm(store, label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `Activity ${label} ${suffix}`,
    firstName: label,
    lastName: 'Admin',
    email: `activity.${label.toLowerCase()}.${suffix}@example.com`,
    password: 'ActivityFeedPass123'
  })
  return store.requireUser(registered.token)
}

function insertProfileEvent(storage, { firmId, actorUserId, entityId, action = 'profile.created', at }) {
  storage.insertAuditEvent({
    id: randomUUID(),
    actor: { userId: actorUserId },
    firmId,
    entityType: 'profile',
    entityId,
    action,
    after: { kind: 'client' },
    timestamp: at
  })
}

function insertAuthEvent(storage, { firmId, actorUserId, at }) {
  storage.insertAuditEvent({
    id: randomUUID(),
    actor: { userId: actorUserId },
    firmId,
    entityType: 'user',
    entityId: actorUserId,
    action: 'auth.login.succeeded',
    after: {},
    timestamp: at
  })
}

test('activity: firm scoping, category filter, actor resolution, and keyset pagination', async () => {
  const { storage, store, modules } = await loadStack()

  const admin = registerFirm(store, 'FirmA')
  const other = registerFirm(store, 'FirmB')

  // Five profile events for firm A with strictly increasing timestamps.
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
  ids.forEach((entityId, index) => {
    insertProfileEvent(storage, {
      firmId: admin.firmId,
      actorUserId: admin.id,
      entityId,
      at: `2026-01-01T00:00:0${index}.000Z`
    })
  })
  // A firm B profile event that must never appear in firm A reads.
  insertProfileEvent(storage, {
    firmId: other.firmId,
    actorUserId: other.id,
    entityId: 'other-profile',
    at: '2026-01-01T00:00:09.000Z'
  })

  // Page through category=profiles, 2 at a time, and reassemble.
  const collected = []
  let cursor
  for (let guard = 0; guard < 10; guard += 1) {
    const page = modules.activity.list(admin, { category: 'profiles', limit: 2, cursor })
    collected.push(...page.events)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }

  const collectedIds = collected.map((event) => event.entityId)
  assert.deepEqual(collectedIds, ['p5', 'p4', 'p3', 'p2', 'p1'], 'newest-first, stable order, no gaps')
  assert.equal(new Set(collectedIds).size, collectedIds.length, 'no duplicates across pages')
  assert.equal(
    collected.find((event) => event.entityId === 'other-profile'),
    undefined,
    'firm B events are invisible to firm A'
  )

  // Actor resolution to a real display name (batch), category, and summary.
  const sample = collected[0]
  assert.equal(sample.actorUserId, admin.id)
  assert.equal(sample.actorName, `${admin.firstName} ${admin.lastName}`)
  assert.equal(sample.category, 'profiles')
  assert.equal(sample.summary, 'Created a client')

})

test('activity: non-admins see only their own auth events; admins see all', async () => {
  const { storage, store, modules } = await loadStack()

  const admin = registerFirm(store, 'AuthFirm')
  const firmId = admin.firmId

  const advisorId = `advisor-${randomUUID().slice(0, 8)}`
  const advisor = { id: advisorId, firmId, role: 'advisor', email: 'adv@example.com' }

  // Own advisor event, an admin event, and a third user's event.
  insertAuthEvent(storage, { firmId, actorUserId: advisorId, at: '2026-02-01T00:00:01.000Z' })
  insertAuthEvent(storage, { firmId, actorUserId: admin.id, at: '2026-02-01T00:00:02.000Z' })
  insertAuthEvent(storage, { firmId, actorUserId: 'stranger-1', at: '2026-02-01T00:00:03.000Z' })

  const advisorAuth = modules.activity.list(advisor, { category: 'auth', limit: 200 })
  const advisorActors = new Set(advisorAuth.events.map((event) => event.actorUserId))
  assert.ok(advisorActors.has(advisorId), 'advisor sees their own auth events')
  assert.equal(advisorActors.has(admin.id), false, "advisor cannot see another user's auth events")
  assert.equal(advisorActors.has('stranger-1'), false, "advisor cannot see a stranger's auth events")

  const adminAuth = modules.activity.list(admin, { category: 'auth', limit: 200 })
  const adminActors = new Set(adminAuth.events.map((event) => event.actorUserId))
  assert.ok(adminActors.has(advisorId) && adminActors.has(admin.id) && adminActors.has('stranger-1'),
    'admin sees every auth actor')

  // Business events remain firm-wide for advisors regardless of actor.
  insertProfileEvent(storage, { firmId, actorUserId: admin.id, entityId: 'biz-1', at: '2026-02-02T00:00:01.000Z' })
  const advisorProfiles = modules.activity.list(advisor, { category: 'profiles', limit: 200 })
  assert.ok(
    advisorProfiles.events.find((event) => event.entityId === 'biz-1'),
    'advisor sees firm-wide business events even by other actors'
  )

})

test('activity: permission gating and actor filter', async () => {
  const { storage, store, modules } = await loadStack()

  const admin = registerFirm(store, 'GateFirm')
  const firmId = admin.firmId

  insertProfileEvent(storage, { firmId, actorUserId: admin.id, entityId: 'g1', at: '2026-03-01T00:00:01.000Z' })
  insertProfileEvent(storage, { firmId, actorUserId: 'other-actor', entityId: 'g2', at: '2026-03-01T00:00:02.000Z' })

  // readonly is allowed (canReadAudit includes readonly); client is denied.
  const readonly = { id: 'ro-1', firmId, role: 'readonly', email: 'ro@example.com' }
  assert.doesNotThrow(() => modules.activity.list(readonly, {}))

  const client = { id: 'client-1', firmId, role: 'client', email: 'client@example.com' }
  assert.throws(() => modules.activity.list(client, {}), (error) => error.statusCode === 403)

  // Actor filter narrows to a single actor's events.
  const filtered = modules.activity.list(admin, { category: 'profiles', actorId: 'other-actor', limit: 200 })
  assert.deepEqual(filtered.events.map((event) => event.entityId), ['g2'])

})
