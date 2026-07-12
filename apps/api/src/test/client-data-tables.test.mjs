import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
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

// Fake-but-shaped envelope: the migration copies note bodies verbatim, so
// byte-exact round-tripping is provable with arbitrary ciphertext bytes.
function envelope(marker) {
  return { keyId: 'key-v1', alg: 'aes-256-gcm', ciphertext: `aabbcc:${marker}` }
}

function buildLegacyBlob() {
  return {
    marker: 'legacy-pre-007',
    firms: [
      { id: 'firm-a', name: 'Alpha Firm', slug: 'alpha-firm' },
      { id: 'firm-b', name: 'Beta Firm', slug: 'beta-firm' }
    ],
    users: [],
    profiles: [],
    households: [],
    stageChanges: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [],
    auditEvents: [],
    notes: [
      {
        id: 'note-1',
        firmId: 'firm-a',
        profileId: 'prospect-1',
        body: '',
        bodyEncrypted: envelope('note-a-bytes'),
        createdByUserId: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'note-2',
        firmId: 'firm-b',
        profileId: 'prospect-b1',
        body: 'Plaintext note for the other tenant.',
        createdByUserId: 'user-2',
        createdAt: '2026-01-02T00:00:00.000Z'
      }
    ],
    documentUploads: [
      {
        id: 'upload-1',
        firmId: 'firm-a',
        clientId: 'client-1',
        name: 'Driver License',
        category: 'identification',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'advisor',
        notes: 'Verified in person.',
        malwareScan: { status: 'clean', provider: 'demo', reference: 'scan-1', checkedAt: '2026-01-01T00:00:00.000Z' },
        object: {
          bucket: 'documents',
          key: 'firm-a/client-1/dl.pdf',
          checksum: 'sha256:abcdef',
          contentType: 'application/pdf',
          retentionClass: 'uploaded_document'
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'upload-2',
        firmId: 'firm-b',
        clientId: 'client-b1',
        name: 'Beta doc',
        category: 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'client',
        object: {
          bucket: 'documents',
          key: 'firm-b/client-b1/doc.pdf',
          checksum: null,
          contentType: 'application/pdf',
          retentionClass: 'uploaded_document'
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    portalLinks: [
      {
        id: 'link-1',
        firmId: 'firm-a',
        profileId: 'client-1',
        token: 'portal-token-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        maxUses: 3,
        usedCount: 0,
        revokedAt: null,
        lastUsedAt: null,
        scope: { templateIds: ['tmpl-1'], uploadCategories: null }
      },
      {
        id: 'link-2',
        firmId: 'firm-b',
        profileId: 'client-b1',
        token: 'portal-token-b',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        maxUses: 1,
        usedCount: 0,
        revokedAt: null,
        lastUsedAt: null,
        scope: { templateIds: null, uploadCategories: null }
      }
    ],
    invites: [
      {
        id: 'invite-1',
        firmId: 'firm-a',
        email: 'newadvisor@example.com',
        role: 'advisor',
        invitedByUserId: 'user-1',
        token: 'invite-token-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z'
      },
      {
        id: 'invite-2',
        firmId: 'firm-b',
        email: 'other@example.com',
        role: 'readonly',
        invitedByUserId: 'user-2',
        token: 'invite-token-b',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z'
      }
    ],
    passwordResets: [],
    authAttempts: [],
    boardVersions: {},
    pipelineStagesByFirm: {},
    pipelineStages: []
  }
}

// Creates a database that looks exactly like a deployed pre-007 install:
// schema at user_version 6 with the client-data entities still in the blob.
function createLegacyDatabase(tempDir, blob) {
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const db = new DatabaseSync(join(tempDir, 'data', 'app.db'))
  try {
    for (const migration of migrations) {
      if (migration.version > 6) continue
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))").run(
      JSON.stringify(blob)
    )
  } finally {
    db.close()
  }
}

test('migration 007 backfills client-data entities from a legacy blob and clears them', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-client-data-'))
  const blob = buildLegacyBlob()
  const originalNotePayload = JSON.stringify(blob.notes[0])
  const originalUploadPayload = JSON.stringify(blob.documentUploads[0])
  createLegacyDatabase(tempDir, blob)

  const storage = await loadStorage(tempDir)
  try {
    // Notes: firm-scoped rows, byte-exact through the payload column.
    assert.deepEqual(
      storage.listNoteRowsByFirm('firm-a').map((note) => note.id),
      ['note-1']
    )
    assert.deepEqual(
      storage.listNoteRowsByProfile('firm-a', 'prospect-1').map((note) => note.id),
      ['note-1']
    )
    assert.equal(JSON.stringify(storage.listNoteRowsByProfile('firm-a', 'prospect-1')[0]), originalNotePayload)

    // Document uploads: firm-scoped, object + malwareScan round-trip byte-exact.
    assert.deepEqual(
      storage.listDocumentUploadRowsByFirm('firm-a').map((u) => u.id),
      ['upload-1']
    )
    assert.equal(JSON.stringify(storage.getDocumentUploadRow('upload-1')), originalUploadPayload)

    // Portal link + invite token lookups resolve to the right rows.
    assert.equal(storage.findPortalLinkRowByToken('portal-token-a').id, 'link-1')
    assert.equal(storage.findPortalLinkRowByToken('portal-token-a').scope.templateIds[0], 'tmpl-1')
    assert.equal(storage.findInviteRowByToken('invite-token-a').id, 'invite-1')
    assert.equal(storage.findInviteRowByToken('invite-token-a').email, 'newadvisor@example.com')

    // Blob keys cleared and schema at the latest version.
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      const parsed = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.deepEqual(parsed.notes, [])
      assert.deepEqual(parsed.documentUploads, [])
      assert.deepEqual(parsed.portalLinks, [])
      assert.deepEqual(parsed.invites, [])
      assert.equal(Number(inspect.prepare('PRAGMA user_version').get().user_version), LATEST_SCHEMA_VERSION)
    } finally {
      inspect.close()
    }

    // loadState keeps the mirrors empty and does not resurrect blob copies.
    const state = storage.loadState(() => {
      throw new Error('seed factory must not run when a blob exists')
    })
    assert.deepEqual(state.notes, [])
    assert.deepEqual(state.documentUploads, [])
    assert.deepEqual(state.portalLinks, [])
    assert.deepEqual(state.invites, [])

    // Re-running the migration runner is a no-op and keeps rows intact.
    const rerunDb = new DatabaseSync(storage.DB_PATH)
    try {
      const rerun = runMigrations(rerunDb)
      assert.equal(rerun.applied.length, 0)
      assert.equal(rerunDb.prepare('SELECT COUNT(*) AS count FROM notes').get().count, 2)
      assert.equal(rerunDb.prepare('SELECT COUNT(*) AS count FROM document_uploads').get().count, 2)
      assert.equal(rerunDb.prepare('SELECT COUNT(*) AS count FROM portal_links').get().count, 2)
      assert.equal(rerunDb.prepare('SELECT COUNT(*) AS count FROM invites').get().count, 2)
    } finally {
      rerunDb.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

test('client-data rows are firm-scoped: cross-tenant reads miss', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-client-data-scoping-'))
  createLegacyDatabase(tempDir, buildLegacyBlob())

  const storage = await loadStorage(tempDir)
  try {
    // Notes never leak across firms.
    assert.deepEqual(storage.listNoteRowsByProfile('firm-b', 'prospect-1'), [])
    assert.deepEqual(
      storage.listNoteRowsByFirm('firm-b').map((n) => n.id),
      ['note-2']
    )

    // Uploads: scoped read with the wrong firm behaves like a missing row.
    assert.equal(storage.getDocumentUploadRow('upload-1', { firmId: 'firm-b' }), null)
    // Unscoped read resolves so the store's tenancy validator can raise.
    assert.equal(storage.getDocumentUploadRow('upload-1')?.firmId, 'firm-a')
    assert.deepEqual(storage.listDocumentUploadRowsByFirmClient('firm-b', 'client-1'), [])
    assert.deepEqual(
      storage.listDocumentUploadRowsByFirmClient('firm-a', 'client-1').map((u) => u.id),
      ['upload-1']
    )
    // The unscoped lifecycle sweep sees every firm's uploads.
    assert.deepEqual(
      storage.listAllDocumentUploadRows().map((u) => u.id).sort(),
      ['upload-1', 'upload-2']
    )

    // Portal link ownership: unscoped by id, but tokens are globally unique.
    assert.equal(storage.getPortalLinkRow('link-1')?.firmId, 'firm-a')
    assert.equal(storage.findPortalLinkRowByToken('does-not-exist'), null)
    assert.equal(storage.findInviteRowByToken('does-not-exist'), null)
  } finally {
    storage.closeDatabase()
  }
})

test('document upload lifecycle status change round-trips through the table', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-upload-lifecycle-'))
  createLegacyDatabase(tempDir, buildLegacyBlob())

  const storage = await loadStorage(tempDir)
  try {
    const upload = storage.getDocumentUploadRow('upload-1')
    assert.equal(upload.status, 'uploaded')

    // Simulate applyLifecyclePolicies mutating + persisting the row.
    upload.status = 'archived'
    upload.archivedAt = '2026-06-01T00:00:00.000Z'
    storage.upsertDocumentUploadRow(upload)

    const reread = storage.getDocumentUploadRow('upload-1')
    assert.equal(reread.status, 'archived')
    assert.equal(reread.archivedAt, '2026-06-01T00:00:00.000Z')
    // The promoted status column tracks the payload (queryable by status).
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      assert.equal(inspect.prepare('SELECT status FROM document_uploads WHERE id = ?').get('upload-1').status, 'archived')
    } finally {
      inspect.close()
    }
    // Everything else round-trips byte-exact aside from the mutated fields.
    assert.equal(reread.object.key, 'firm-a/client-1/dl.pdf')
    assert.equal(reread.malwareScan.reference, 'scan-1')
  } finally {
    storage.closeDatabase()
  }
})

test('portal link + invite repositories support upsert, token lookup, and invite delete', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-client-data-writes-'))
  const storage = await loadStorage(tempDir)
  try {
    const link = {
      id: 'link-new',
      firmId: 'firm-a',
      profileId: 'client-9',
      token: 'fresh-portal-token',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      maxUses: 2,
      usedCount: 0,
      revokedAt: null,
      lastUsedAt: null,
      scope: { templateIds: null, uploadCategories: ['identification'] }
    }
    storage.upsertPortalLinkRow(link)
    assert.equal(storage.findPortalLinkRowByToken('fresh-portal-token').id, 'link-new')

    // Consuming a use is an upsert of the mutated object.
    const consumed = { ...link, usedCount: 1, lastUsedAt: '2026-02-01T00:00:00.000Z' }
    storage.upsertPortalLinkRow(consumed)
    assert.equal(storage.findPortalLinkRowByToken('fresh-portal-token').usedCount, 1)
    assert.equal(storage.getPortalLinkRow('link-new').lastUsedAt, '2026-02-01T00:00:00.000Z')

    const invite = {
      id: 'invite-new',
      firmId: 'firm-a',
      email: 'fresh@example.com',
      role: 'advisor',
      token: 'fresh-invite-token',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    storage.upsertInviteRow(invite)
    assert.equal(storage.findInviteRowByToken('fresh-invite-token').id, 'invite-new')

    // Accepting an invite deletes the row by id.
    assert.equal(storage.deleteInviteRow('invite-new'), true)
    assert.equal(storage.findInviteRowByToken('fresh-invite-token'), null)
    assert.equal(storage.deleteInviteRow('invite-new'), false)
  } finally {
    storage.closeDatabase()
  }
})
