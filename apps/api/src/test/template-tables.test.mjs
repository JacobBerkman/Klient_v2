import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { migrations } from '../migrations/index.mjs'

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

async function loadStore(tempDir) {
  const previousCwd = process.cwd()
  const previousEnv = { ...process.env }
  process.chdir(tempDir)
  process.env.APP_SECRET = 'test-secret-for-template-tables'
  process.env.AUTH_PROVIDER = 'local'
  try {
    const stamp = `${Date.now()}-${Math.random()}`
    const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${stamp}`)
    return storeModule.createStore()
  } finally {
    process.chdir(previousCwd)
    process.env = previousEnv
  }
}

function emptySeedState() {
  return {
    marker: 'seed',
    firms: [],
    users: [],
    households: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    profiles: [],
    exportJobs: [],
    notes: [],
    auditEvents: []
  }
}

// ---------------------------------------------------------------------------
// (a) Repository firm-scoping + cross-tenant isolation for each of the three
// template tables.
// ---------------------------------------------------------------------------
test('template repos enforce firm scoping and cross-tenant misses', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-scope-'))
  const storage = await loadStorage(tempDir)
  try {
    storage.saveState(emptySeedState())

    // template_aggregates (the canonical source of truth)
    storage.upsertTemplateAggregateRow({
      id: 'agg-a',
      firmId: 'firm-a',
      name: 'Alpha Aggregate',
      kind: 'document',
      publishState: 'published',
      mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }]
    })
    storage.upsertTemplateAggregateRow({
      id: 'agg-b',
      firmId: 'firm-b',
      name: 'Beta Aggregate',
      kind: 'form',
      publishState: 'draft'
    })

    // Byte-exact payload round-trip: the mapping array survives verbatim.
    const aggA = storage.getTemplateAggregateRow('agg-a', { firmId: 'firm-a' })
    assert.equal(aggA.name, 'Alpha Aggregate')
    assert.deepEqual(aggA.mappings, [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }])
    // Cross-tenant read of another firm's aggregate id → null.
    assert.equal(storage.getTemplateAggregateRow('agg-b', { firmId: 'firm-a' }), null)
    assert.equal(storage.getTemplateAggregateRow('agg-b', { firmId: 'firm-b' }).name, 'Beta Aggregate')
    assert.deepEqual(
      storage.listTemplateAggregateRows({ firmId: 'firm-a' }).map((entry) => entry.id),
      ['agg-a']
    )
    // Cross-tenant delete is a no-op; the scoped delete removes the row.
    assert.equal(storage.deleteTemplateAggregateRow('agg-b', 'firm-a'), false)
    assert.ok(storage.getTemplateAggregateRow('agg-b'))
    assert.equal(storage.deleteTemplateAggregateRow('agg-b', 'firm-b'), true)
    assert.equal(storage.getTemplateAggregateRow('agg-b'), null)

    // form_templates companion projection table
    storage.upsertFormTemplateRow({ id: 'form-a', firmId: 'firm-a', name: 'Alpha Form', sections: [] })
    storage.upsertFormTemplateRow({ id: 'form-b', firmId: 'firm-b', name: 'Beta Form', sections: [] })
    assert.equal(storage.getFormTemplateRow('form-b', { firmId: 'firm-a' }), null)
    assert.equal(storage.getFormTemplateRow('form-a', { firmId: 'firm-a' }).name, 'Alpha Form')
    assert.deepEqual(
      storage.listFormTemplateRows({ firmId: 'firm-b' }).map((entry) => entry.id),
      ['form-b']
    )

    // document_templates companion projection table
    storage.upsertDocumentTemplateRow({ id: 'doc-a', firmId: 'firm-a', name: 'Alpha Doc', status: 'published' })
    storage.upsertDocumentTemplateRow({ id: 'doc-b', firmId: 'firm-b', name: 'Beta Doc', status: 'draft' })
    assert.equal(storage.getDocumentTemplateRow('doc-a', { firmId: 'firm-b' }), null)
    assert.equal(storage.getDocumentTemplateRow('doc-a', { firmId: 'firm-a' }).name, 'Alpha Doc')
    assert.deepEqual(
      storage.listDocumentTemplateRows({ firmId: 'firm-a' }).map((entry) => entry.id),
      ['doc-a']
    )
    // The promoted status column tracks the projected publish state.
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      assert.equal(inspect.prepare('SELECT status FROM document_templates WHERE id = ?').get('doc-a').status, 'published')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

// ---------------------------------------------------------------------------
// (b) Migration 010 backfills the three tables and clears the blob arrays.
// ---------------------------------------------------------------------------
function createLegacyDatabaseAtV9(tempDir, blob) {
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const db = new DatabaseSync(join(tempDir, 'data', 'app.db'))
  try {
    for (const migration of migrations) {
      if (migration.version > 9) continue
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))").run(
      JSON.stringify(blob)
    )
    // A pre-existing derived-projection row (as the pre-010 saveState would have
    // left it) so the migration's keyed INSERT OR IGNORE is provably idempotent.
    db.prepare('INSERT INTO template_aggregates (id, firm_id, name, kind, publish_state, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
      'agg-1',
      'firm-a',
      'Existing Aggregate',
      'document',
      'published',
      JSON.stringify({ id: 'agg-1', firmId: 'firm-a', name: 'Existing Aggregate', kind: 'document', publishState: 'published', mappings: [{ pdfField: 'a', sourcePath: 'profile.firstName' }] })
    )
  } finally {
    db.close()
  }
}

test('migration 010 backfills template tables and clears the blob arrays', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-migration-'))
  const blob = {
    marker: 'legacy-pre-010',
    formTemplates: [{ id: 'form-1', firmId: 'firm-a', name: 'Discovery Form', sections: [{ id: 's1', fields: [] }] }],
    documentTemplates: [
      { id: 'doc-1', firmId: 'firm-a', name: 'Intake PDF', status: 'draft', blueprint: { sections: [] } }
    ],
    templateAggregates: [
      // Same id as the pre-existing projection row: INSERT OR IGNORE keeps the
      // existing payload, proving idempotency + no clobber.
      { id: 'agg-1', firmId: 'firm-a', name: 'Aggregate One', kind: 'document', publishState: 'published', mappings: [{ pdfField: 'a', sourcePath: 'profile.firstName' }] },
      { id: 'agg-2', firmId: 'firm-b', name: 'Aggregate Two', kind: 'form', publishState: 'draft' }
    ]
  }
  createLegacyDatabaseAtV9(tempDir, blob)

  const storage = await loadStorage(tempDir)
  try {
    // template_aggregates backfilled + firm-scoped; the pre-existing row's
    // canonical payload (mappings) survives byte-exact.
    assert.deepEqual(
      storage.listTemplateAggregateRows().map((entry) => entry.id).sort(),
      ['agg-1', 'agg-2']
    )
    assert.deepEqual(storage.getTemplateAggregateRow('agg-1').mappings, [
      { pdfField: 'a', sourcePath: 'profile.firstName' }
    ])
    assert.equal(storage.getTemplateAggregateRow('agg-2', { firmId: 'firm-a' }), null)
    assert.equal(storage.getTemplateAggregateRow('agg-2', { firmId: 'firm-b' }).name, 'Aggregate Two')

    // form_templates + document_templates backfilled.
    assert.equal(storage.getFormTemplateRow('form-1').name, 'Discovery Form')
    assert.equal(storage.getDocumentTemplateRow('doc-1').name, 'Intake PDF')

    // The blob no longer carries the three template arrays.
    const inspect = new DatabaseSync(join(tempDir, 'data', 'app.db'), { readOnly: true })
    try {
      const parsed = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.deepEqual(parsed.formTemplates, [])
      assert.deepEqual(parsed.documentTemplates, [])
      assert.deepEqual(parsed.templateAggregates, [])
      assert.equal(parsed.marker, 'legacy-pre-010')
    } finally {
      inspect.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

// ---------------------------------------------------------------------------
// (c) Publish-persistence anti-pattern test — the MOST important one.
// A published/mutated document template + its aggregate must be readable back
// from the RELATIONAL TABLE (not the blob / not the in-memory working set),
// proving the mutation site's upsert fired. Without the upsert the publish
// would live only in memory and revert on the next boot's rehydration.
// ---------------------------------------------------------------------------
test('publishing + mapping edits persist to the template_aggregates table (survive reload)', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-publish-'))
  const store = await loadStore(tempDir)

  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(session.token)

  const created = store.createDocumentTemplate(admin, {
    name: 'Persisted Intake Template',
    fileName: 'intake.pdf',
    blueprint: { sections: [{ title: 'Client' }] },
    mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }]
  })

  // Edit the mappings, then publish (requires versionBump + changelog).
  store.updateTemplateMappings(
    admin,
    created.id,
    [{ pdfField: 'client_email', sourcePath: 'profile.email' }],
    { expectedVersionHash: created.versionHash }
  )
  const published = store.publishTemplate(admin, created.id, {
    versionBump: '1.0.0',
    changelog: 'Initial release'
  })
  assert.equal(published.status, 'published')

  // Read back straight from the relational table (NOT the blob, NOT the
  // in-memory working set): the upsert at the publish/mapping mutation sites
  // must have persisted the publishState AND the edited mapping.
  const persisted = store.__getTemplateAggregateForTest(created.id)
  assert.ok(persisted, 'aggregate row must exist in template_aggregates')
  assert.equal(persisted.publishState, 'published')
  assert.deepEqual(persisted.mappings, [{ pdfField: 'client_email', sourcePath: 'profile.email' }])
  const publishVersion = (persisted.versions || []).find((entry) => entry.event === 'published')
  assert.ok(publishVersion, 'the published version snapshot must be persisted')
  assert.equal(publishVersion.immutable, true)

  // The companion document_templates projection row tracks the published state.
  const docRow = store.__listDocumentTemplatesForTest().find((entry) => entry.id === created.id)
  assert.ok(docRow)
  assert.equal(docRow.status, 'published')

  // The blob must NOT carry the aggregate (it is stripped/emptied on save).
  const inspect = new DatabaseSync(resolve(tempDir, 'data', 'app.db'), { readOnly: true })
  try {
    const parsed = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
    assert.deepEqual(parsed.templateAggregates ?? [], [])
    assert.deepEqual(parsed.documentTemplates ?? [], [])
  } finally {
    inspect.close()
  }

  // Reload: a fresh store instance rehydrates its working set from the table.
  // The published template must still be published — not reverted to draft.
  const reloaded = await loadStore(tempDir)
  const reloadedSession = reloaded.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const reloadedAdmin = reloaded.requireUser(reloadedSession.token)
  const afterReload = reloaded
    .listTemplateAggregates(reloadedAdmin, { kind: 'document' })
    .find((entry) => entry.id === created.id)
  assert.ok(afterReload, 'the template must rehydrate from the table after reload')
  assert.equal(afterReload.publishState, 'published')
  assert.deepEqual(afterReload.mappings, [{ pdfField: 'client_email', sourcePath: 'profile.email' }])
})
