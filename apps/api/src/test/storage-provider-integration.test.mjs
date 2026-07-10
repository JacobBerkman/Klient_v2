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

    if (options.method === 'DELETE') {
      objects.delete(key)
      return new Response('', { status: 200 })
    }

    return new Response('Unsupported method', { status: 405 })
  }
}

function bootstrapClientUser(store, firmId) {
  const profile = store.state.profiles.find((entry) => entry.firmId === firmId && entry.kind === 'client')
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
  store.state.users.push(clientUser)
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
    const firmId = store.state.firms[0].id
    const admin = { ...store.state.users.find((entry) => entry.firmId === firmId && entry.role === 'admin') }
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
