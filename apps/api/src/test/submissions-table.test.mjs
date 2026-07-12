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

// form_submissions, draft_step_states, and pending_upload_intents are the
// relational sources of truth for the draft-churn entities: migration 005
// backfills them from the blob, the store performs targeted row reads/writes,
// and the blob serializes empty arrays for the three keys.
process.env.APP_SECRET = 'test-secret-submissions-table'
process.env.AUTH_PROVIDER = 'local'

// Cache-busted store plus the SHARED (non-cache-busted) storage module: the
// store's internal `import './storage.mjs'` resolves to the same instance, so
// table inspections here hit the same database the store writes.
async function loadStoreWithSharedStorage() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-submissions-table-'))
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

function registerFirm(store, label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label.toLowerCase()}.${suffix}@example.com`,
    password: 'SubmissionsPass123'
  })
  return store.requireUser(registered.token)
}

test('migration 005: legacy blob entities are backfilled into tables and cleared from the blob, idempotently', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-submissions-migration-'))
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const dbPath = join(tempDir, 'data', 'app.db')

  const nowIso = new Date().toISOString()
  const legacyState = {
    firms: [],
    users: [],
    formSubmissions: [
      {
        id: 'submission-1',
        firmId: 'firm-1',
        clientId: 'client-1',
        templateId: 'template-1',
        status: 'submitted',
        data: { goals: 'Retire' },
        createdAt: nowIso,
        updatedAt: nowIso
      },
      {
        id: 'submission-2',
        firmId: 'firm-1',
        clientId: 'client-1',
        templateId: 'template-1',
        status: 'draft',
        source: 'portal',
        data: { goals: 'Draft goals' },
        createdAt: nowIso,
        updatedAt: nowIso
      }
    ],
    draftStepStates: [
      {
        firmId: 'firm-1',
        clientId: 'client-1',
        draftId: 'submission-2',
        sectionId: 'goals',
        version: 3,
        data: { fields: { primaryGoal: 'Independence' } },
        updatedAt: nowIso
      }
    ],
    pendingUploadIntents: [
      {
        id: 'intent-1',
        firmId: 'firm-1',
        clientId: 'client-1',
        fileName: 'doc.pdf',
        object: { bucket: 'documents', key: 'firm-1/doc.pdf' },
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    ]
  }

  const legacyDb = new DatabaseSync(dbPath)
  try {
    migrations[0].up(legacyDb)
    legacyDb.exec('PRAGMA user_version = 1')
    legacyDb
      .prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))")
      .run(JSON.stringify(legacyState))

    const result = runMigrations(legacyDb)
    assert.equal(result.currentVersion, LATEST_SCHEMA_VERSION)
    assert.ok(LATEST_SCHEMA_VERSION >= 5, 'submission-entities migration must advance the schema version')

    const submissionRows = legacyDb
      .prepare('SELECT id, firm_id, client_id, template_id, status, source, payload FROM form_submissions ORDER BY rowid')
      .all()
    assert.equal(submissionRows.length, 2)
    assert.equal(submissionRows[0].id, 'submission-1')
    assert.equal(submissionRows[0].firm_id, 'firm-1')
    assert.equal(submissionRows[0].status, 'submitted')
    assert.equal(submissionRows[1].source, 'portal')
    assert.deepEqual(JSON.parse(submissionRows[0].payload).data, { goals: 'Retire' })

    const sectionRow = legacyDb
      .prepare('SELECT firm_id, client_id, draft_id, section_id, version, payload FROM draft_step_states')
      .get()
    assert.equal(sectionRow.version, 3, 'section-state version must be promoted for the SQL guard')
    assert.deepEqual(JSON.parse(sectionRow.payload), { fields: { primaryGoal: 'Independence' } })

    const intentRow = legacyDb.prepare('SELECT id, firm_id, expires_at FROM pending_upload_intents').get()
    assert.equal(intentRow.id, 'intent-1')
    assert.ok(intentRow.expires_at)

    const blob = JSON.parse(legacyDb.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
    assert.deepEqual(blob.formSubmissions, [], 'blob formSubmissions must be cleared after migration')
    assert.deepEqual(blob.draftStepStates, [], 'blob draftStepStates must be cleared after migration')
    assert.deepEqual(blob.pendingUploadIntents, [], 'blob pendingUploadIntents must be cleared after migration')

    // Idempotency: re-running the backfill must not duplicate or resurrect rows.
    migrations.find((migration) => migration.version === 5).up(legacyDb)
    assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM form_submissions').get().count, 2)
    assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM draft_step_states').get().count, 1)
    assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM pending_upload_intents').get().count, 1)
  } finally {
    legacyDb.close()
  }
})

test('store: submissions live in the table, blob stays empty, and rows survive a restart', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()
  const admin = registerFirm(store, 'Persist')

  const profile = store.createProfile(admin, { kind: 'client', firstName: 'Table', lastName: 'Client' })
  const submission = store.createFormSubmission(admin, {
    clientId: profile.id,
    templateId: 'intake-form',
    status: 'draft',
    data: { householdMembers: [{ id: 'member-1', fullName: 'Pat Primary' }] }
  })
  assert.equal(submission.revisionId, 1)
  assert.deepEqual(submission.collaborators, [{ userId: admin.id, permission: 'write' }])

  // The blob no longer carries any of the three entity arrays.
  const blob = JSON.parse(readBlobPayload(storage.DB_PATH))
  assert.deepEqual(blob.formSubmissions, [])
  assert.deepEqual(blob.draftStepStates, [])
  assert.deepEqual(blob.pendingUploadIntents, [])

  // Reads come from the table (including the seeded demo submission for the
  // demo firm, which must have been seeded into the table on first boot).
  const listed = store.listFormSubmissions(admin)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, submission.id)

  // Restart: a fresh store instance sees the same rows because the table is
  // the source of truth.
  const restarted = storeModule.createStore()
  const restartedAdmin = restarted.requireUser(
    restarted.login({ email: 'admin@demo.test', password: 'ChangeMe123!' }).token
  )
  const dashboard = restarted.getDashboard(restartedAdmin)
  assert.ok(dashboard.stats.forms >= 1, 'seeded demo submission must survive in the table')
  const detail = restarted.getProfileDetail(
    { ...restartedAdmin, firmId: admin.firmId, role: 'admin' },
    profile.id
  )
  assert.equal(detail.submissions.length, 1)
  assert.equal(detail.submissions[0].id, submission.id)
})

test('store: portal draft section states use a real SQL version guard with the legacy conflict contract', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()
  const admin = registerFirm(store, 'Sections')

  const profile = store.createProfile(admin, { kind: 'client', firstName: 'Portal', lastName: 'Client' })
  const template = store.createFormTemplate(admin, {
    name: 'Discovery',
    sections: [{ title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] }]
  })
  const link = store.createPortalLink(admin, profile.id, { maxUses: 10, templateIds: [template.id] })
  const draft = store.portalSubmit(link.token, {
    templateId: template.id,
    status: 'draft',
    data: { primaryGoal: 'Initial' }
  })
  assert.equal(draft.status, 'draft')

  // Initial write: expectedVersion 0 -> version 1.
  const first = store.savePortalDraftSectionState(link.token, draft.id, 'goals', {
    expectedVersion: 0,
    data: { fields: { primaryGoal: 'Financial independence' } }
  })
  assert.equal(first.ok, true)
  assert.equal(first.state.version, 1)

  // Racing initial write loses via INSERT OR IGNORE and returns latest state.
  const duplicateInitial = store.savePortalDraftSectionState(link.token, draft.id, 'goals', {
    expectedVersion: 0,
    data: { fields: { primaryGoal: 'Racer' } }
  })
  assert.equal(duplicateInitial.ok, false)
  assert.equal(duplicateInitial.conflict, true)
  assert.equal(duplicateInitial.reason, 'Section draft state is stale.')
  assert.equal(duplicateInitial.state.version, 1)

  // Optimistic update: expectedVersion 1 -> version 2.
  const second = store.savePortalDraftSectionState(link.token, draft.id, 'goals', {
    expectedVersion: 1,
    data: { fields: { primaryGoal: 'Tab A update' } }
  })
  assert.equal(second.ok, true)
  assert.equal(second.state.version, 2)
  assert.deepEqual(second.state.data, { fields: { primaryGoal: 'Tab A update' } })

  // Stale cross-tab write: guarded UPDATE ... WHERE version = 1 matches no
  // row; the conflict response carries the latest server state.
  const stale = store.savePortalDraftSectionState(link.token, draft.id, 'goals', {
    expectedVersion: 1,
    data: { fields: { primaryGoal: 'Tab B stale write' } }
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict, true)
  assert.equal(stale.state.version, 2)
  assert.deepEqual(stale.state.data, { fields: { primaryGoal: 'Tab A update' } })

  // Reads come straight from the table.
  const read = store.getPortalDraftSectionState(link.token, draft.id, 'goals')
  assert.equal(read.version, 2)
  const listedStates = store.listPortalDraftSectionStates(link.token, draft.id)
  assert.equal(listedStates.length, 1)

  // Client-visible contract the portal UI relies on to adopt per-section saving:
  //   (1) getPortalData exposes the draft submission id (= the draftId the
  //       per-section PUT is scoped to) plus its data snapshot, and
  //   (2) listPortalDraftSectionStates exposes each section's normalized id +
  //       version so the client can seed expectedVersion and overlay section
  //       data on top of the submission snapshot.
  const portalData = store.getPortalData(link.token)
  const adoptedDraft = portalData.submissions.find(
    (entry) => entry.templateId === template.id && entry.status === 'draft'
  )
  assert.ok(adoptedDraft, 'portal data must expose the draft so the client can adopt its id')
  assert.equal(adoptedDraft.id, draft.id)
  assert.equal(adoptedDraft.data.primaryGoal, 'Initial')
  const goalsState = listedStates.find((entry) => entry.sectionId === 'goals')
  assert.ok(goalsState, 'section states must expose the normalized section id')
  assert.equal(goalsState.version, 2)
  assert.deepEqual(goalsState.data, { fields: { primaryGoal: 'Tab A update' } })

  // The guard is enforced in SQL, not in JS: bypass the store and race the
  // storage helper directly with a stale expected version.
  const raced = storage.saveDraftSectionStateGuarded({
    firmId: link.firmId,
    clientId: profile.id,
    draftId: draft.id,
    sectionId: 'goals',
    expectedVersion: 1,
    data: { fields: { primaryGoal: 'SQL race' } },
    updatedAt: new Date().toISOString()
  })
  assert.equal(raced.ok, false)
  assert.equal(raced.conflict, true)
  assert.equal(raced.state.version, 2)
})

test('store: upload intents are rows with consume-once and expiry lifecycle semantics', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()
  const admin = registerFirm(store, 'Intents')

  const profile = store.createProfile(admin, { kind: 'client', firstName: 'Upload', lastName: 'Client' })
  const link = store.createPortalLink(admin, profile.id, { maxUses: 10 })

  const presign = await store.createPortalUploadPresign(link.token, {
    fileName: 'tax-package.pdf',
    contentType: 'application/pdf',
    category: 'general'
  })
  assert.ok(presign.uploadId)
  assert.ok(storage.getUploadIntent(presign.uploadId, admin.firmId), 'intent row must exist after presign')

  // Firm scoping: the intent is invisible to another firm's lookup.
  assert.equal(storage.getUploadIntent(presign.uploadId, 'firm-other'), null)

  // Consuming the upload deletes the intent row (consume-once).
  const upload = store.portalUpload(link.token, {
    uploadId: presign.uploadId,
    name: 'Tax Package',
    category: 'general',
    object: presign.object,
    malwareScan: { status: 'pending', provider: 'test' }
  })
  assert.equal(upload.status, 'uploaded')
  assert.equal(storage.getUploadIntent(presign.uploadId, admin.firmId), null, 'consumed intent must be deleted')

  // Expiry lifecycle: an expired intent is swept, an unexpired one survives.
  const expired = storage.insertUploadIntent({
    id: randomUUID(),
    firmId: admin.firmId,
    clientId: profile.id,
    fileName: 'stale.pdf',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  })
  const fresh = storage.insertUploadIntent({
    id: randomUUID(),
    firmId: admin.firmId,
    clientId: profile.id,
    fileName: 'fresh.pdf',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
  })
  await store.runLifecyclePolicies(admin)
  assert.equal(storage.getUploadIntent(expired.id, admin.firmId), null, 'expired intent must be swept')
  assert.ok(storage.getUploadIntent(fresh.id, admin.firmId), 'unexpired intent must survive the sweep')
})

test('store: submission reads and writes are firm-scoped', async () => {
  const { storage, storeModule } = await loadStoreWithSharedStorage()
  const store = storeModule.createStore()
  const userA = registerFirm(store, 'FirmA')
  const userB = registerFirm(store, 'FirmB')

  const profileA = store.createProfile(userA, { kind: 'client', firstName: 'Only', lastName: 'FirmA' })
  const submissionA = store.createFormSubmission(userA, {
    clientId: profileA.id,
    templateId: 'intake-form',
    status: 'submitted',
    data: { goals: 'Scoped' }
  })

  assert.ok(store.listFormSubmissions(userA).find((entry) => entry.id === submissionA.id))
  assert.equal(
    store.listFormSubmissions(userB).find((entry) => entry.id === submissionA.id),
    undefined,
    'firm B must never see firm A submissions'
  )
  assert.equal(store.getDashboard(userA).stats.forms, 1)
  assert.equal(store.getDashboard(userB).stats.forms, 0)

  // Cross-firm targeted mutations are rejected by tenancy validation.
  assert.throws(() => store.updateSubmission(userB, submissionA.id, { status: 'draft' }))
  assert.throws(() => store.deleteSubmission(userB, submissionA.id))
  assert.ok(storage.getFormSubmissionById(submissionA.id, { firmId: userA.firmId }))
  assert.equal(storage.getFormSubmissionById(submissionA.id, { firmId: userB.firmId }), null)

  // Draft revision guard keys on (id, firm_id): a stale revision never writes.
  const draft = store.createFormSubmission(userA, {
    clientId: profileA.id,
    templateId: 'intake-form',
    status: 'draft',
    data: { goals: 'Draft' }
  })
  const lock = store.acquireDraftLock(userA, draft.id, {})
  assert.equal(lock.ok, true)
  const staleRevision = store.reviseDraftSubmission(userA, draft.id, {
    expectedRevisionId: 99,
    leaseId: lock.lock.leaseId,
    data: { goals: 'Stale' }
  })
  assert.equal(staleRevision.ok, false)
  assert.equal(staleRevision.conflict, true)
  assert.equal(staleRevision.mergePrompt.type, 'revision_conflict')
  const revised = store.reviseDraftSubmission(userA, draft.id, {
    expectedRevisionId: 1,
    leaseId: lock.lock.leaseId,
    data: { goals: 'Revised' }
  })
  assert.equal(revised.ok, true)
  assert.equal(revised.submission.revisionId, 2)
  assert.equal(storage.getFormSubmissionById(draft.id, { firmId: userA.firmId }).revisionId, 2)
})
