import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLocalFilesystemStorageProvider } from '../object-storage/local-provider.mjs'
import { createS3CompatibleStorageProvider } from '../object-storage/s3-provider.mjs'
import { createObjectStorage } from '../object-storage/index.mjs'
import {
  providerSupportsHttpPresignedDownload,
  STORAGE_PROVIDER_ERROR_CODE,
  StorageProviderError
} from '../object-storage/provider-interface.mjs'

test('presigned tokens expire, enforce scope, and are one-time use', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-test-'))
  const provider = createLocalFilesystemStorageProvider({ rootDir })
  try {
    const presigned = await provider.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/upload.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 1,
      actorId: 'user-1',
      context: 'client',
      intent: 'upload_document'
    })
    const token = new URL(`http://localhost${presigned.url}`).searchParams.get('token')
    assert.ok(token)

    const wrongActor = provider.consumePresignedToken(token, 'upload', {
      actorId: 'user-2',
      context: 'client',
      intent: 'upload_document'
    })
    assert.equal(wrongActor, null)

    const valid = provider.consumePresignedToken(token, 'upload', {
      actorId: 'user-1',
      context: 'client',
      intent: 'upload_document'
    })
    assert.equal(valid.key, 'firm/upload.pdf')

    const replay = provider.consumePresignedToken(token, 'upload', {
      actorId: 'user-1',
      context: 'client',
      intent: 'upload_document'
    })
    assert.equal(replay, null)

    const expiring = await provider.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/soon-expired.pdf',
      contentType: 'application/pdf',
      expiresInSeconds: 1
    })
    const expiringToken = new URL(`http://localhost${expiring.url}`).searchParams.get('token')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const expired = provider.consumePresignedToken(expiringToken, 'upload')
    assert.equal(expired, null)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('object metadata captures checksum and etag after write', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-meta-'))
  const provider = createLocalFilesystemStorageProvider({ rootDir })
  try {
    const body = Buffer.from('hello world')
    const result = await provider.putObject({ bucket: 'docs', key: 'firm/hello.txt', body })
    assert.ok(result.etag)
    assert.equal(result.checksum, result.etag)

    const metadata = provider.getObjectMetadata({ bucket: 'docs', key: 'firm/hello.txt' })
    assert.equal(metadata.checksum, result.etag)
    assert.equal(metadata.sizeBytes, body.length)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('retention classes are validated for upload intents', async () => {
  const storage = createObjectStorage({
    provider: {
      async putObject() {
        return { etag: 'ok' }
      },
      async getObject() {
        return { body: Buffer.from(''), etag: 'ok', contentType: 'application/octet-stream' }
      },
      async createPresignedUploadUrl() {
        return { method: 'PUT', url: '/signed', headers: {}, expiresAt: new Date().toISOString() }
      },
      async createPresignedDownloadUrl() {
        return { method: 'GET', url: '/signed', headers: {}, expiresAt: new Date().toISOString() }
      },
      async deleteObject() {}
    },
    retentionPolicies: {
      uploaded_document: { ttlDays: 365, archiveAfterDays: 90, purgeAfterDays: 730 }
    }
  })

  await assert.rejects(
    storage.createPresignedUploadUrl({
      bucket: 'docs',
      key: 'firm/file.bin',
      retentionClass: 'missing_class'
    }),
    /Unknown retention class/
  )
})

function buildS3Provider(fetchImpl) {
  return createS3CompatibleStorageProvider({
    endpoint: 'https://example-s3.local',
    region: 'us-east-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    fetchImpl
  })
}

test('HTTP presigned download capability is advertised per provider, not sniffed from env', async () => {
  const s3Provider = buildS3Provider(async () => new Response('', { status: 200 }))
  const rootDir = await mkdtemp(join(tmpdir(), 'klient-storage-caps-'))
  try {
    const localProvider = createLocalFilesystemStorageProvider({ rootDir })

    assert.equal(providerSupportsHttpPresignedDownload(s3Provider), true)
    assert.equal(providerSupportsHttpPresignedDownload(localProvider), false)
    assert.equal(providerSupportsHttpPresignedDownload(null), false)
    assert.equal(providerSupportsHttpPresignedDownload({}), false)

    const s3Storage = createObjectStorage({ provider: s3Provider, retentionPolicies: {} })
    const localObjectStorage = createObjectStorage({ provider: localProvider, retentionPolicies: {} })
    assert.equal(s3Storage.supportsHttpPresignedDownload(), true)
    assert.equal(localObjectStorage.supportsHttpPresignedDownload(), false)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('S3 presigned download URLs sign response content disposition and type overrides', async () => {
  const provider = buildS3Provider(async () => new Response('', { status: 200 }))
  const presigned = await provider.createPresignedDownloadUrl({
    bucket: 'exports',
    key: 'firm-1/exports/quarterly report.pdf',
    expiresInSeconds: 300,
    responseContentDisposition: 'attachment; filename="quarterly_report.pdf"',
    responseContentType: 'application/pdf'
  })

  assert.equal(presigned.method, 'GET')
  const url = new URL(presigned.url)
  assert.equal(url.origin, 'https://example-s3.local')
  assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="quarterly_report.pdf"')
  assert.equal(url.searchParams.get('response-content-type'), 'application/pdf')
  assert.ok(url.searchParams.get('X-Amz-Signature'), 'response overrides must be inside the signed query')
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300')

  const plain = await provider.createPresignedDownloadUrl({ bucket: 'exports', key: 'firm-1/exports/plain.pdf' })
  const plainUrl = new URL(plain.url)
  assert.equal(plainUrl.searchParams.get('response-content-disposition'), null)
  assert.equal(plainUrl.searchParams.get('response-content-type'), null)
})

test('S3 statObject issues HEAD requests and maps missing objects to NOT_FOUND', async () => {
  const seen = []
  const provider = buildS3Provider(async (url, options = {}) => {
    seen.push({ url: String(url), method: options.method })
    if (String(url).includes('missing')) return new Response(null, { status: 404 })
    return new Response(null, {
      status: 200,
      headers: {
        etag: '"etag-9"',
        'content-type': 'application/pdf',
        'content-length': '9',
        'x-amz-meta-checksum': 'sum-9'
      }
    })
  })

  const stat = await provider.statObject({ bucket: 'exports', key: 'firm-1/exports/present.pdf' })
  assert.equal(seen[0].method, 'HEAD')
  assert.equal(stat.sizeBytes, 9)
  assert.equal(stat.contentType, 'application/pdf')
  assert.equal(stat.checksum, 'sum-9')

  await assert.rejects(
    () => provider.statObject({ bucket: 'exports', key: 'firm-1/exports/missing.pdf' }),
    (error) => error instanceof StorageProviderError && error.code === STORAGE_PROVIDER_ERROR_CODE.NOT_FOUND
  )
})
