/**
 * @typedef {Object} StorageObjectDescriptor
 * @property {string} bucket
 * @property {string} key
 * @property {string | null} [checksum]
 * @property {string | null} [contentType]
 * @property {string | null} [retentionClass]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} PresignedRequest
 * @property {string} url
 * @property {'PUT'|'GET'|'DELETE'} method
 * @property {Record<string,string>} headers
 * @property {string} expiresAt
 */

export const STORAGE_PROVIDER_ERROR_CODE = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CONFLICT: 'CONFLICT',
  UNAVAILABLE: 'UNAVAILABLE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UNKNOWN: 'UNKNOWN'
}

export class StorageProviderError extends Error {
  constructor(message, { code = STORAGE_PROVIDER_ERROR_CODE.UNKNOWN, operation = null, provider = null, cause = null } = {}) {
    super(message)
    this.name = 'StorageProviderError'
    this.code = code
    this.operation = operation
    this.provider = provider
    if (cause) this.cause = cause
  }
}

export function normalizeStorageObjectDescriptor(input = {}, { requireBody = false } = {}) {
  const bucket = String(input.bucket || '').trim()
  const key = String(input.key || '').replace(/^\/+/, '')
  if (!bucket || !key) {
    throw new StorageProviderError('Storage object requires non-empty bucket and key.', {
      code: STORAGE_PROVIDER_ERROR_CODE.INVALID_ARGUMENT
    })
  }

  if (requireBody && input.body === undefined) {
    throw new StorageProviderError('Storage putObject requires a body payload.', {
      code: STORAGE_PROVIDER_ERROR_CODE.INVALID_ARGUMENT
    })
  }

  const normalizedMetadata =
    input.metadata && typeof input.metadata === 'object'
      ? Object.fromEntries(Object.entries(input.metadata).map(([k, v]) => [String(k), String(v)]))
      : {}

  if (input.retentionClass) {
    normalizedMetadata.retentionClass = String(input.retentionClass)
  }

  if (input.checksum) {
    normalizedMetadata.checksum = String(input.checksum)
  }

  return {
    ...input,
    bucket,
    key,
    checksum: input.checksum || null,
    contentType: input.contentType || 'application/octet-stream',
    retentionClass: input.retentionClass || null,
    metadata: normalizedMetadata
  }
}

export function wrapStorageError(error, fallback = {}) {
  if (error instanceof StorageProviderError) return error
  return new StorageProviderError(error?.message || 'Storage provider operation failed.', {
    code: fallback.code || STORAGE_PROVIDER_ERROR_CODE.UNKNOWN,
    operation: fallback.operation || null,
    provider: fallback.provider || null,
    cause: error
  })
}

/**
 * @typedef {Object} StorageProvider
 * @property {(object: StorageObjectDescriptor & { body: Buffer | Uint8Array | string }) => Promise<{ etag?: string | null, checksum?: string | null, contentType?: string | null, retentionClass?: string | null, metadata?: Record<string,string> }>} putObject
 * @property {(object: StorageObjectDescriptor) => Promise<{ body: Buffer, etag?: string | null, checksum?: string | null, contentType?: string | null, retentionClass?: string | null, metadata?: Record<string,string> }>} getObject
 * @property {(object: StorageObjectDescriptor & { expiresInSeconds?: number }) => Promise<PresignedRequest>} createPresignedUploadUrl
 * @property {(object: StorageObjectDescriptor & { expiresInSeconds?: number }) => Promise<PresignedRequest>} createPresignedDownloadUrl
 * @property {(object: StorageObjectDescriptor) => Promise<void>} deleteObject
 */

export function assertStorageProvider(provider) {
  const methods = ['putObject', 'getObject', 'createPresignedUploadUrl', 'createPresignedDownloadUrl', 'deleteObject']
  for (const method of methods) {
    if (typeof provider?.[method] !== 'function') {
      throw new StorageProviderError(`Invalid storage provider: missing ${method}().`, {
        code: STORAGE_PROVIDER_ERROR_CODE.INVALID_ARGUMENT,
        operation: 'provider.assert'
      })
    }
  }
  return provider
}
