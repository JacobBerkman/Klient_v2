import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../store.mjs'
import { createObjectStorage } from '../object-storage/index.mjs'
import { createLocalFilesystemStorageProvider } from '../object-storage/local-provider.mjs'
import { createS3CompatibleStorageProvider } from '../object-storage/s3-provider.mjs'
import { STORAGE_PROVIDER_ERROR_CODE, StorageProviderError, assertStorageProvider } from '../object-storage/provider-interface.mjs'
import { createStoreExportsRepository } from '../modules/exports/store-repository.mjs'
import { enqueueExportJob, markExportJobCompleted } from '../storage.mjs'

function buildInMemoryS3Fetch() {
  const objects = new Map()
  return async function inMemoryFetch(url, options = {}) {
    const { pathname } = new URL(url)
    const [, bucket, ...parts] = pathname.split('/')
    const key = `${bucket}/${parts.join('/')}`

    if (options.method === 'PUT') {
      const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body || '')
      const headers = new Headers(options.headers || {})
      const metadata = {}
      for (const [name, value] of headers.entries()) {
        if (name.toLowerCase().startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value
      }
      objects.set(key, {
        body,
        etag: `"etag-${body.length}"`,
        contentType: headers.get('content-type') || 'application/octet-stream',
        metadata
      })
      return new Response('', { status: 200, headers: { etag: `"etag-${body.length}"` } })
    }

    if (options.method === 'GET') {
      const value = objects.get(key)
      if (!value) return new Response('Not Found', { status: 404 })
      const responseHeaders = new Headers({ etag: value.etag, 'content-type': value.contentType })
      Object.entries(value.metadata).forEach(([name, headerValue]) => {
        responseHeaders.set(`x-amz-meta-${name}`, headerValue)
      })
      return new Response(value.body, { status: 200, headers: responseHeaders })
    }

    if (options.method === 'HEAD') {
      const value = objects.get(key)
      if (!value) return new Response(null, { status: 404 })
      const responseHeaders = new Headers({
        etag: value.etag,
        'content-type': value.contentType,
        'content-length': String(value.body.length)
      })
      Object.entries(value.metadata).forEach(([name, headerValue]) => {
        responseHeaders.set(`x-amz-meta-${name}`, headerValue)
      })
      return new Response(null, { status: 200, headers: responseHeaders })
    }

    if (options.method === 'DELETE') {
      objects.delete(key)
      return new Response('', { status: 200 })
    }

    return new Response('Unsupported method', { status: 405 })
  }
}

function bootstrapClientUser(store, firmId) {
  // profiles table is the source of truth: read through the store API.
  const profile = store.listProfiles({ id: 'bootstrap-reader', role: 'admin', firmId }, 'client')[0]
  const clientUser = {
    id: randomUUID(),
    firmId,
    email: profile.email,
    passwordHash: 'x',
    firstName: 'Client',
    lastName: 'User',
    role: 'client',
    createdAt: new Date().toISOString()
  }
  // users is a source-of-truth table now (migration 009): write through the
  // store hook instead of pushing onto a stripped blob array.
  store.__upsertUserForTest(clientUser)
  return {
    id: clientUser.id,
    firmId,
    email: clientUser.email,
    firstName: clientUser.firstName,
    lastName: clientUser.lastName,
    role: clientUser.role
  }
}

async function runContractSuite(name, buildProvider) {
  await test(`storage provider contract parity (${name})`, async () => {
    const provider = await buildProvider()
    assertStorageProvider(provider)

    const object = {
      bucket: 'test-docs',
      key: `firm-${name}/document.txt`,
      contentType: 'text/plain',
      retentionClass: 'uploaded_document',
      checksum: 'abc123'
    }

    const put = await provider.putObject({ ...object, body: Buffer.from('hello storage') })
    assert.ok(put.etag)
    assert.equal(put.retentionClass, 'uploaded_document')

    const get = await provider.getObject(object)
    assert.equal(get.body.toString('utf8'), 'hello storage')
    assert.equal(get.retentionClass, 'uploaded_document')

    const uploadUrl = await provider.createPresignedUploadUrl(object)
    assert.equal(uploadUrl.method, 'PUT')
    assert.ok(uploadUrl.expiresAt)

    const downloadUrl = await provider.createPresignedDownloadUrl(object)
    assert.equal(downloadUrl.method, 'GET')
    assert.ok(downloadUrl.expiresAt)

    await provider.deleteObject(object)
    await assert.rejects(
      () => provider.getObject(object),
      (error) => error instanceof StorageProviderError && error.code === STORAGE_PROVIDER_ERROR_CODE.NOT_FOUND
    )

    if (typeof provider.__cleanup === 'function') await provider.__cleanup()
  })

  await test(`document/export flows are interface-only (${name})`, async () => {
    const provider = await buildProvider()
    const objectStorage = createObjectStorage({
      provider,
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
    const client = bootstrapClientUser(store, firmId)

    const presign = await store.createClientUploadPresign(client, {
      fileName: 'tax-return.pdf',
      contentType: 'application/pdf',
      category: 'tax'
    })
    assert.equal(presign.object.retentionClass, 'uploaded_document')

    const saved = store.submitClientUpload(client, {
      uploadId: presign.uploadId,
      name: 'Tax Return 2025',
      category: 'tax',
      object: presign.object
    })
    assert.equal(saved.object.bucket, 'test-docs')

    const exportJob = store.listExports(admin).find((entry) => entry.firmId === firmId)
    const download = await store.createExportDownloadUrl(admin, exportJob.id)
    assert.equal(download.method, 'GET')

    const lifecycle = await store.runLifecyclePolicies(admin)
    assert.ok(Array.isArray(lifecycle.uploads))

    if (typeof provider.__cleanup === 'function') await provider.__cleanup()
  })
}

await runContractSuite('local', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-contract-local-'))
  const provider = createLocalFilesystemStorageProvider({ rootDir })
  provider.__cleanup = () => rm(rootDir, { recursive: true, force: true })
  return provider
})

await runContractSuite('s3', async () =>
  createS3CompatibleStorageProvider({
    endpoint: 'https://example-s3.local',
    region: 'us-east-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    fetchImpl: buildInMemoryS3Fetch()
  })
)

const downloadRetentionPolicies = {
  export_artifact: { ttlDays: 14, archiveAfterDays: 1, purgeAfterDays: 2 },
  uploaded_document: { ttlDays: 30, archiveAfterDays: 1, purgeAfterDays: 2 }
}

function buildExportsRepository(objectStorage) {
  return createStoreExportsRepository({
    state: { firms: [], users: [], profiles: [], templateAggregates: [], formSubmissions: [] },
    persist: () => {},
    addAuditEvent: () => {},
    objectStorage
  })
}

async function seedCompletedExportJob({ objectStorage, firmId, fileName, withBytes = true }) {
  const jobId = `export-download-${randomUUID()}`
  const key = `${firmId}/exports/${fileName}`
  if (withBytes) {
    await objectStorage.putObject({
      bucket: 'test-exports',
      key,
      body: Buffer.from('export-artifact-bytes'),
      contentType: 'application/pdf',
      retentionClass: 'export_artifact'
    })
  }
  enqueueExportJob({ id: jobId, firmId, clientId: null, type: 'pdf' })
  markExportJobCompleted(jobId, {
    fileName,
    object: { bucket: 'test-exports', key, contentType: 'application/pdf', checksum: 'seeded-checksum' }
  })
  return { jobId, key }
}

await test('S3-mode export download returns a presigned redirect with tenant scoping enforced', async () => {
  const objectStorage = createObjectStorage({
    provider: createS3CompatibleStorageProvider({
      endpoint: 'https://example-s3.local',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      fetchImpl: buildInMemoryS3Fetch()
    }),
    bucketDocuments: 'test-docs',
    bucketExports: 'test-exports',
    retentionPolicies: downloadRetentionPolicies
  })
  assert.equal(objectStorage.supportsHttpPresignedDownload(), true)

  const repository = buildExportsRepository(objectStorage)
  const firmId = `firm-presign-${randomUUID()}`
  const { jobId } = await seedCompletedExportJob({ objectStorage, firmId, fileName: 'statement.pdf' })

  const download = await repository.getDownload({ id: 'user-owner', firmId, role: 'admin' }, jobId)
  assert.ok(download.redirectUrl, 'S3 mode must return a presigned redirect URL')
  assert.equal(download.body, undefined, 'S3 mode must not stream bytes through the API')
  assert.equal(download.fileName, 'statement.pdf')
  assert.ok(download.expiresAt)

  const presignedUrl = new URL(download.redirectUrl)
  assert.equal(presignedUrl.origin, 'https://example-s3.local')
  assert.ok(presignedUrl.searchParams.get('X-Amz-Signature'))
  assert.equal(
    presignedUrl.searchParams.get('response-content-disposition'),
    'attachment; filename="statement.pdf"'
  )
  assert.equal(presignedUrl.searchParams.get('response-content-type'), 'application/pdf')

  // Unauthorized access: a user from another firm is rejected before any URL is issued.
  await assert.rejects(
    () => repository.getDownload({ id: 'intruder', firmId: `firm-other-${randomUUID()}`, role: 'admin' }, jobId),
    /Export not found/
  )
})

await test('S3-mode export download falls back to re-render when artifact bytes were never persisted', async () => {
  const objectStorage = createObjectStorage({
    provider: createS3CompatibleStorageProvider({
      endpoint: 'https://example-s3.local',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      fetchImpl: buildInMemoryS3Fetch()
    }),
    bucketDocuments: 'test-docs',
    bucketExports: 'test-exports',
    retentionPolicies: downloadRetentionPolicies
  })
  const repository = buildExportsRepository(objectStorage)
  const firmId = `firm-legacy-${randomUUID()}`
  const { jobId } = await seedCompletedExportJob({
    objectStorage,
    firmId,
    fileName: 'legacy.pdf',
    withBytes: false
  })

  const download = await repository.getDownload({ id: 'user-owner', firmId, role: 'admin' }, jobId)
  assert.equal(download.redirectUrl, undefined, 'missing objects must not be handed out as presigned URLs')
  assert.ok(Buffer.isBuffer(download.body), 'legacy jobs must fall back to a re-rendered artifact')
  assert.ok(download.body.length > 0)
})

await test('local-mode export download still streams bytes with tenant scoping enforced', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-download-local-'))
  try {
    const objectStorage = createObjectStorage({
      provider: createLocalFilesystemStorageProvider({ rootDir }),
      bucketDocuments: 'test-docs',
      bucketExports: 'test-exports',
      retentionPolicies: downloadRetentionPolicies
    })
    assert.equal(objectStorage.supportsHttpPresignedDownload(), false)

    const repository = buildExportsRepository(objectStorage)
    const firmId = `firm-local-${randomUUID()}`
    const { jobId } = await seedCompletedExportJob({ objectStorage, firmId, fileName: 'statement.pdf' })

    const download = await repository.getDownload({ id: 'user-owner', firmId, role: 'admin' }, jobId)
    assert.equal(download.redirectUrl, undefined, 'local mode must keep streaming through the API')
    assert.ok(Buffer.isBuffer(download.body))
    assert.equal(download.body.toString('utf8'), 'export-artifact-bytes')
    assert.equal(download.fileName, 'statement.pdf')
    assert.equal(download.contentType, 'application/pdf')

    await assert.rejects(
      () => repository.getDownload({ id: 'intruder', firmId: `firm-other-${randomUUID()}`, role: 'admin' }, jobId),
      /Export not found/
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
