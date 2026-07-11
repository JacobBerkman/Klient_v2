import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  normalizeStorageObjectDescriptor,
  STORAGE_PROVIDER_ERROR_CODE,
  StorageProviderError,
  wrapStorageError
} from './provider-interface.mjs'

function nowIso() {
  return new Date().toISOString()
}

export function createLocalFilesystemStorageProvider({ rootDir }) {
  const baseDir = resolve(rootDir || resolve(process.cwd(), 'data', 'objects'))
  const presignedTokens = new Map()
  const objectMetadata = new Map()

  function keyPath(bucket, key) {
    const normalized = String(key || '').replace(/^\/+/, '')
    return resolve(baseDir, bucket, normalized)
  }

  function metadataKey({ bucket, key }) {
    return `${bucket}:${key}`
  }

  function putToken(operation, object, expiresInSeconds = 300) {
    const token = randomUUID()
    const normalizedObject = {
      ...object,
      maxSizeBytes: Number(object?.maxSizeBytes || 0) || null,
      tokenScope: {
        actorId: object?.actorId || null,
        context: object?.context || null,
        intent: object?.intent || null
      }
    }
    presignedTokens.set(token, {
      operation,
      object: normalizedObject,
      consumed: false,
      oneTime: object?.oneTime !== false,
      expiresAt: Date.now() + Math.max(1, Number(expiresInSeconds || 300)) * 1000
    })
    return token
  }

  function digest(buffer) {
    return createHash('sha256').update(buffer).digest('hex')
  }

  return {
    type: 'local',
    baseDir,
    // Local presigned URLs are API-relative one-time tokens, not URLs a browser can
    // fetch on its own, so downloads must keep streaming through the API process.
    capabilities: { httpPresignedDownload: false },
    async putObject(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input, { requireBody: true })
        const absolutePath = keyPath(object.bucket, object.key)
        await mkdir(dirname(absolutePath), { recursive: true })
        const buffer = Buffer.isBuffer(object.body) ? object.body : Buffer.from(object.body)
        await writeFile(absolutePath, buffer)
        const etag = digest(buffer)
        const metadata = {
          ...object.metadata,
          checksum: etag,
          retentionClass: object.retentionClass || null,
          sizeBytes: String(buffer.length),
          uploadedAt: nowIso()
        }
        objectMetadata.set(metadataKey(object), {
          checksum: etag,
          etag,
          contentType: object.contentType,
          retentionClass: object.retentionClass || null,
          metadata,
          sizeBytes: buffer.length,
          uploadedAt: metadata.uploadedAt
        })
        return {
          etag,
          checksum: etag,
          contentType: object.contentType,
          retentionClass: object.retentionClass,
          metadata
        }
      } catch (error) {
        throw wrapStorageError(error, { provider: 'local', operation: 'putObject' })
      }
    },
    async getObject(input) {
      const object = normalizeStorageObjectDescriptor(input)
      try {
        const absolutePath = keyPath(object.bucket, object.key)
        const body = await readFile(absolutePath)
        const stored = objectMetadata.get(metadataKey(object)) || {}
        const etag = stored.etag || digest(body)
        return {
          body,
          etag,
          checksum: stored.checksum || etag,
          contentType: stored.contentType || object.contentType,
          retentionClass: stored.retentionClass || object.retentionClass || null,
          metadata: stored.metadata || object.metadata
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new StorageProviderError(`Object not found: ${object.bucket}/${object.key}`, {
            code: STORAGE_PROVIDER_ERROR_CODE.NOT_FOUND,
            provider: 'local',
            operation: 'getObject',
            cause: error
          })
        }
        throw wrapStorageError(error, { provider: 'local', operation: 'getObject' })
      }
    },
    async createPresignedUploadUrl(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        const token = putToken('upload', object, object.expiresInSeconds || 900)
        const expiresAt = new Date(Date.now() + (object.expiresInSeconds || 900) * 1000).toISOString()
        return {
          method: 'PUT',
          url: `/api/storage/presigned/upload?token=${encodeURIComponent(token)}`,
          headers: {
            'Content-Type': object.contentType,
            ...(object.retentionClass ? { 'X-Storage-Retention-Class': object.retentionClass } : {}),
            ...(object.metadata?.checksum ? { 'X-Storage-Checksum': object.metadata.checksum } : {}),
            ...(object.actorId ? { 'X-Storage-Actor-Id': object.actorId } : {}),
            ...(object.context ? { 'X-Storage-Context': object.context } : {}),
            ...(object.intent ? { 'X-Storage-Intent': object.intent } : {})
          },
          expiresAt
        }
      } catch (error) {
        throw wrapStorageError(error, { provider: 'local', operation: 'createPresignedUploadUrl' })
      }
    },
    async createPresignedDownloadUrl(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        const token = putToken('download', object, object.expiresInSeconds || 900)
        const expiresAt = new Date(Date.now() + (object.expiresInSeconds || 900) * 1000).toISOString()
        return {
          method: 'GET',
          url: `/api/storage/presigned/download?token=${encodeURIComponent(token)}`,
          headers: {},
          expiresAt
        }
      } catch (error) {
        throw wrapStorageError(error, { provider: 'local', operation: 'createPresignedDownloadUrl' })
      }
    },
    async deleteObject(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        const absolutePath = keyPath(object.bucket, object.key)
        if (existsSync(absolutePath)) {
          await rm(absolutePath, { force: true })
        }
        objectMetadata.delete(metadataKey(object))
      } catch (error) {
        throw wrapStorageError(error, { provider: 'local', operation: 'deleteObject' })
      }
    },
    consumePresignedToken(token, operation, context = {}) {
      const entry = presignedTokens.get(token)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        presignedTokens.delete(token)
        return null
      }
      if (entry.operation !== operation) return null
      if (entry.consumed && entry.oneTime) return null
      if (entry.object?.tokenScope?.actorId && context.actorId && entry.object.tokenScope.actorId !== context.actorId)
        return null
      if (entry.object?.tokenScope?.context && context.context && entry.object.tokenScope.context !== context.context)
        return null
      if (entry.object?.tokenScope?.intent && context.intent && entry.object.tokenScope.intent !== context.intent)
        return null
      if (entry.oneTime) {
        entry.consumed = true
        presignedTokens.delete(token)
      }
      return entry.object
    },
    getObjectMetadata(input) {
      const object = normalizeStorageObjectDescriptor(input)
      return objectMetadata.get(metadataKey(object)) || null
    },
    describeHealth() {
      const info = {
        provider: 'local',
        baseDir,
        exists: existsSync(baseDir),
        activePresignedTokens: presignedTokens.size,
        checkedAt: nowIso()
      }
      return info
    },
    async statObject(input) {
      const object = normalizeStorageObjectDescriptor(input)
      const absolutePath = keyPath(object.bucket, object.key)
      const objectStat = await stat(absolutePath)
      const stored = objectMetadata.get(metadataKey(object)) || {}
      return {
        sizeBytes: objectStat.size,
        updatedAt: objectStat.mtime.toISOString(),
        etag: stored.etag || null,
        checksum: stored.checksum || null
      }
    }
  }
}
