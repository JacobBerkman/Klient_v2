/**
 * @typedef {Object} StorageObjectDescriptor
 * @property {string} bucket
 * @property {string} key
 * @property {string | null} [checksum]
 * @property {string | null} [contentType]
 * @property {string} [retentionClass]
 */

/**
 * @typedef {Object} PresignedRequest
 * @property {string} url
 * @property {'PUT'|'GET'|'DELETE'} method
 * @property {Record<string,string>} headers
 * @property {string} expiresAt
 */

/**
 * @typedef {Object} StorageProvider
 * @property {(object: StorageObjectDescriptor & { body: Buffer | Uint8Array | string }) => Promise<{ etag?: string | null }>} putObject
 * @property {(object: StorageObjectDescriptor) => Promise<{ body: Buffer, etag?: string | null, contentType?: string | null }>} getObject
 * @property {(object: StorageObjectDescriptor & { expiresInSeconds?: number }) => Promise<PresignedRequest>} createPresignedUploadUrl
 * @property {(object: StorageObjectDescriptor & { expiresInSeconds?: number }) => Promise<PresignedRequest>} createPresignedDownloadUrl
 * @property {(object: StorageObjectDescriptor) => Promise<void>} deleteObject
 */

export function assertStorageProvider(provider) {
  const methods = ['putObject', 'getObject', 'createPresignedUploadUrl', 'createPresignedDownloadUrl', 'deleteObject']
  for (const method of methods) {
    if (typeof provider?.[method] !== 'function') {
      throw new Error(`Invalid storage provider: missing ${method}().`)
    }
  }
  return provider
}
