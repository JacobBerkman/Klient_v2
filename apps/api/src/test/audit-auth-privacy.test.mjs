import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStack() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-audit-privacy-'))
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

async function setup() {
  const { storage, store, modules } = await loadStack()
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `Audit Privacy ${suffix}`,
    firstName: 'Ada',
    lastName: 'Admin',
    email: `audit.admin.${suffix}@example.com`,
    password: 'AuditPrivacyPass123'
  })
  const admin = store.requireUser(registered.token)
  // Same firm, non-admin role.
  const advisor = { ...admin, id: `advisor-${randomUUID().slice(0, 8)}`, role: 'advisor' }

  const OTHER_USER = `other-${randomUUID().slice(0, 8)}`
  insertAuthEvent(storage, {
    firmId: admin.firmId,
    actorUserId: OTHER_USER,
    at: new Date().toISOString()
  })
  insertAuthEvent(storage, {
    firmId: admin.firmId,
    actorUserId: advisor.id,
    at: new Date().toISOString()
  })
  return { store, modules, admin, advisor, OTHER_USER }
}

test('raw audit list hides other users auth events from non-admins', async () => {
  const { modules, advisor, OTHER_USER } = await setup()

  const events = modules.audit.list(advisor, {})
  const authEvents = events.filter((event) => String(event.action || '').startsWith('auth.'))

  assert.ok(
    !authEvents.some((event) => event.actor?.userId === OTHER_USER),
    "an advisor must not see another user's auth events through /api/audit"
  )
  assert.ok(
    authEvents.some((event) => event.actor?.userId === advisor.id),
    'an advisor still sees their own auth events'
  )
})

test('raw audit page hides other users auth events from non-admins', async () => {
  const { modules, advisor, OTHER_USER } = await setup()

  const { items } = modules.audit.listPage(advisor, {})
  const authEvents = items.filter((event) => String(event.action || '').startsWith('auth.'))

  assert.ok(
    !authEvents.some((event) => event.actor?.userId === OTHER_USER),
    'the paged audit read applies the same privacy rule as the unpaged one'
  )
})

test('admins still see every auth event', async () => {
  const { modules, admin, OTHER_USER } = await setup()

  const events = modules.audit.list(admin, {})
  assert.ok(
    events.some((event) => event.actor?.userId === OTHER_USER),
    'admins retain full audit visibility for compliance review'
  )
})
