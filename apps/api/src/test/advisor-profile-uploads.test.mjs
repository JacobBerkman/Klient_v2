import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../store.mjs'
import { createObjectStorage } from '../object-storage/index.mjs'
import { createLocalFilesystemStorageProvider } from '../object-storage/local-provider.mjs'
import { getDocumentUploadRow, upsertDocumentUploadRow } from '../storage.mjs'

// Advisor-facing profile attachments reuse the document_uploads relational
// source of truth and the pending_upload_intents handshake, scoped to the
// session user's firm (not a portal token). These tests exercise the store
// paths directly: intent handshake + inline bytes, download streaming,
// firm scoping, archive soft-delete, and retention-sweep compatibility.
//
// Each test provisions a FRESH profile (unique id) so assertions on exact
// upload counts are immune to the shared working-directory SQLite database
// that the serial unit runner reuses across files.

async function buildHarness() {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-advisor-uploads-'))
  const objectStorage = createObjectStorage({
    provider: createLocalFilesystemStorageProvider({ rootDir }),
    bucketDocuments: 'test-docs',
    bucketExports: 'test-exports',
    retentionPolicies: {
      export_artifact: { ttlDays: 14, archiveAfterDays: 1, purgeAfterDays: 2 },
      uploaded_document: { ttlDays: 30, archiveAfterDays: 1, purgeAfterDays: 2 }
    }
  })
  const store = createStore({ objectStorage })
  const firmId = store.__listFirmsForTest()[0].id
  const admin = { ...store.__listUsersForTest(firmId).find((entry) => entry.role === 'admin') }
  const profile = store.createProfile(admin, {
    kind: 'client',
    firstName: 'Attach',
    lastName: `Test-${randomUUID().slice(0, 8)}`,
    email: `attach-${randomUUID().slice(0, 8)}@example.com`
  })
  return { rootDir, objectStorage, store, firmId, admin, profile }
}

test('advisor upload handshake stores bytes and download streams them back (local provider)', async () => {
  const { rootDir, store, admin, profile } = await buildHarness()
  try {
    const presign = await store.createProfileUploadPresign(admin, profile.id, {
      fileName: 'engagement-letter.pdf',
      contentType: 'application/pdf',
      category: 'engagement'
    })
    assert.ok(presign.uploadId, 'presign returns an intent id')
    assert.equal(presign.object.retentionClass, 'uploaded_document')
    assert.equal(presign.object.bucket, 'test-docs')

    const bytes = Buffer.from('%PDF-1.4 advisor engagement letter bytes')
    const saved = await store.completeProfileUpload(admin, profile.id, {
      uploadId: presign.uploadId,
      object: presign.object,
      name: 'Engagement Letter',
      fileName: 'engagement-letter.pdf',
      contentType: 'application/pdf',
      fileBytesBase64: bytes.toString('base64'),
      sizeBytes: bytes.length
    })
    assert.equal(saved.uploadedBy, 'advisor')
    assert.equal(saved.uploadedByUserId, admin.id)
    assert.equal(saved.status, 'uploaded')
    assert.equal(saved.clientId, profile.id)
    assert.equal(saved.sizeBytes, bytes.length)

    // Consuming the intent is part of the handshake: the pending row is gone,
    // so a replay without object metadata cannot store bytes.
    await assert.rejects(
      () =>
        store.completeProfileUpload(admin, profile.id, {
          uploadId: presign.uploadId,
          fileBytesBase64: bytes.toString('base64')
        }),
      /object metadata/,
      'consumed intent cannot be replayed to store bytes without object metadata'
    )

    const listed = store.listProfileUploads(admin, profile.id)
    assert.deepEqual(
      listed.uploads.map((upload) => upload.id),
      [saved.id]
    )

    const download = await store.createProfileUploadDownload(admin, profile.id, saved.id)
    assert.ok(download.body, 'local provider streams bytes through the API')
    assert.equal(download.body.toString(), bytes.toString())
    assert.equal(download.contentType, 'application/pdf')
    assert.equal(download.redirectUrl, undefined, 'local provider must not hand out a presigned redirect')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('advisor upload list is firm-scoped: cross-firm access is rejected and never leaks rows', async () => {
  const { rootDir, store, admin, profile } = await buildHarness()
  try {
    await store.completeProfileUpload(admin, profile.id, {
      name: 'Firm A doc',
      object: { bucket: 'test-docs', key: `firm-a/${profile.id}/doc.pdf`, contentType: 'application/pdf' }
    })

    const intruder = { ...admin, id: 'intruder', firmId: `firm-other-${randomUUID()}` }
    assert.throws(
      () => store.listProfileUploads(intruder, profile.id),
      /not found/i,
      "a user from another firm cannot list this profile's uploads"
    )
    assert.throws(
      () => store.archiveProfileUpload(intruder, profile.id, 'anything'),
      /not found/i,
      "a user from another firm cannot archive this profile's uploads"
    )

    // Owning firm still sees exactly its own upload.
    assert.equal(store.listProfileUploads(admin, profile.id).uploads.length, 1)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('archiving an advisor upload is a soft delete hidden from the default list', async () => {
  const { rootDir, store, admin, profile } = await buildHarness()
  try {
    const saved = await store.completeProfileUpload(admin, profile.id, {
      name: 'To be archived',
      object: { bucket: 'test-docs', key: `firm/${profile.id}/archive-me.pdf`, contentType: 'application/pdf' }
    })

    const archived = store.archiveProfileUpload(admin, profile.id, saved.id)
    assert.equal(archived.status, 'archived')
    assert.ok(archived.archivedAt, 'archivedAt lifecycle timestamp is set')

    assert.deepEqual(
      store.listProfileUploads(admin, profile.id).uploads.map((u) => u.id),
      [],
      'archived uploads are excluded by default'
    )
    assert.deepEqual(
      store.listProfileUploads(admin, profile.id, { includeArchived: true }).uploads.map((u) => u.id),
      [saved.id],
      'includeArchived surfaces archived uploads'
    )

    // Archiving is idempotent.
    const again = store.archiveProfileUpload(admin, profile.id, saved.id)
    assert.equal(again.status, 'archived')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('retention sweep keeps working for advisor-created uploads', async () => {
  const { rootDir, store, admin, profile } = await buildHarness()
  try {
    const saved = await store.completeProfileUpload(admin, profile.id, {
      name: 'Aged advisor doc',
      object: { bucket: 'test-docs', key: `firm/${profile.id}/aged.pdf`, contentType: 'application/pdf' }
    })

    // Age the upload past archiveAfterDays (1) but before purgeAfterDays (2)
    // via the shared storage source of truth, then run the lifecycle sweep.
    const row = getDocumentUploadRow(saved.id)
    row.createdAt = new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString()
    upsertDocumentUploadRow(row)

    const result = await store.runLifecyclePolicies(admin)
    const swept = result.uploads.find((upload) => upload.id === saved.id)
    assert.ok(swept, 'advisor upload is visible to the firm-scoped sweep result')
    assert.equal(swept.status, 'archived', 'lifecycle sweep archives the aged advisor upload')
    assert.ok(swept.archivedAt)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
