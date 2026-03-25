import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createStore } from '../store.mjs'

function buildMockStorage() {
  const calls = { presignUpload: 0, presignDownload: 0, delete: 0 }
  return {
    calls,
    bucketDocuments: 'test-docs',
    bucketExports: 'test-exports',
    retentionPolicies: {
      export_artifact: { ttlDays: 14, archiveAfterDays: 1, purgeAfterDays: 2 },
      uploaded_document: { ttlDays: 30, archiveAfterDays: 1, purgeAfterDays: 2 }
    },
    provider: {},
    async putObject() {
      return { etag: 'mock-etag' }
    },
    async getObject() {
      return { body: Buffer.from('mock') }
    },
    async createPresignedUploadUrl() {
      calls.presignUpload += 1
      return { method: 'PUT', url: '/mock/upload', headers: {}, expiresAt: new Date(Date.now() + 60000).toISOString() }
    },
    async createPresignedDownloadUrl() {
      calls.presignDownload += 1
      return {
        method: 'GET',
        url: '/mock/download',
        headers: {},
        expiresAt: new Date(Date.now() + 60000).toISOString()
      }
    },
    async deleteObject() {
      calls.delete += 1
    },
    describeHealth() {
      return { provider: 'mock' }
    }
  }
}

test('client upload presign stores object metadata via provider contract', async () => {
  const objectStorage = buildMockStorage()
  const store = createStore({ objectStorage })
  const firmId = store.state.firms[0].id
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
  const client = {
    id: clientUser.id,
    firmId,
    email: clientUser.email,
    firstName: clientUser.firstName,
    lastName: clientUser.lastName,
    role: clientUser.role
  }

  const presign = await store.createClientUploadPresign(client, {
    fileName: 'tax-return.pdf',
    contentType: 'application/pdf',
    category: 'tax'
  })
  assert.equal(objectStorage.calls.presignUpload, 1)
  assert.equal(presign.object.bucket, 'test-docs')

  const saved = store.submitClientUpload(client, {
    uploadId: presign.uploadId,
    name: 'Tax Return 2025',
    category: 'tax',
    object: presign.object
  })
  assert.equal(saved.object.bucket, 'test-docs')
  assert.equal(saved.object.retentionClass, 'uploaded_document')
})

test('lifecycle and export download use provider methods', async () => {
  const objectStorage = buildMockStorage()
  const store = createStore({ objectStorage })
  const firmId = store.state.firms[0].id
  const admin = { ...store.state.users.find((entry) => entry.firmId === firmId && entry.role === 'admin') }

  const exportJob = store.state.exportJobs.find((entry) => entry.firmId === firmId)
  const download = await store.createExportDownloadUrl(admin, exportJob.id)
  assert.equal(download.method, 'GET')
  assert.equal(objectStorage.calls.presignDownload, 1)

  store.state.documentUploads.push({
    id: randomUUID(),
    firmId,
    clientId: store.state.profiles[0].id,
    name: 'old',
    category: 'general',
    visibility: 'shared',
    status: 'uploaded',
    uploadedBy: 'advisor',
    object: {
      bucket: 'test-docs',
      key: 'old-object',
      checksum: null,
      contentType: 'application/pdf',
      retentionClass: 'uploaded_document'
    },
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  })

  const result = await store.runLifecyclePolicies(admin)
  assert.ok(result.uploads.some((entry) => entry.status === 'purged' || entry.status === 'archived'))
  assert.ok(objectStorage.calls.delete >= 1)
})
