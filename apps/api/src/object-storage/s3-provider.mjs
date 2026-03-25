import { createHmac, createHash } from 'node:crypto'

import {
  normalizeStorageObjectDescriptor,
  STORAGE_PROVIDER_ERROR_CODE,
  StorageProviderError,
  wrapStorageError
} from './provider-interface.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function awsDate(when = new Date()) {
  const iso = when.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

function encodePath(path = '') {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

export function createS3CompatibleStorageProvider({
  endpoint,
  region,
  accessKeyId,
  secretAccessKey,
  forcePathStyle = true,
  fetchImpl = fetch
}) {
  const endpointUrl = new URL(endpoint)
  const service = 's3'

  function objectUrl(bucket, key) {
    const encodedKey = encodePath(String(key || '').replace(/^\/+/, ''))
    if (forcePathStyle) return new URL(`/${bucket}/${encodedKey}`, endpointUrl)
    return new URL(`${endpointUrl.protocol}//${bucket}.${endpointUrl.host}/${encodedKey}`)
  }

  function toS3MetadataHeaders(metadata = {}) {
    return Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, String(v)]))
  }

  function readS3MetadataHeaders(headers) {
    const metadata = {}
    for (const [key, value] of headers.entries()) {
      if (key.toLowerCase().startsWith('x-amz-meta-')) {
        metadata[key.slice('x-amz-meta-'.length)] = value
      }
    }
    return metadata
  }

  function signPresigned({ method, bucket, key, expiresInSeconds = 900, extraHeaders = {}, query = {} }) {
    const now = new Date()
    const { amzDate, dateStamp } = awsDate(now)
    const host = endpointUrl.host
    const canonicalUri = forcePathStyle
      ? `/${bucket}/${encodePath(String(key || '').replace(/^\/+/, ''))}`
      : `/${encodePath(String(key || '').replace(/^\/+/, ''))}`
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`

    const headers = {
      host,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v)]))
    }

    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${String(v).trim()}\n`)
      .join('')

    const queryParams = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(Math.min(604800, Math.max(1, Number(expiresInSeconds || 900)))),
      'X-Amz-SignedHeaders': signedHeaders,
      ...query
    }

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery(queryParams),
      canonicalHeaders,
      signedHeaders,
      'UNSIGNED-PAYLOAD'
    ].join('\n')

    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n')

    const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), stringToSign, 'hex')
    const finalQuery = canonicalQuery({ ...queryParams, 'X-Amz-Signature': signature })
    const url = forcePathStyle
      ? `${endpointUrl.protocol}//${endpointUrl.host}${canonicalUri}?${finalQuery}`
      : `${endpointUrl.protocol}//${bucket}.${endpointUrl.host}${canonicalUri}?${finalQuery}`

    return {
      url,
      method,
      headers: Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k, String(v)])),
      expiresAt: new Date(now.getTime() + Number(queryParams['X-Amz-Expires']) * 1000).toISOString()
    }
  }

  async function requestSignedUrl(presigned, body, operation, { allowMissing = false } = {}) {
    const response = await fetchImpl(presigned.url, {
      method: presigned.method,
      headers: presigned.headers,
      body
    })
    if (response.ok) return response
    const message = await response.text()
    if (allowMissing && response.status === 404) return response

    const mappedCode =
      response.status === 404
        ? STORAGE_PROVIDER_ERROR_CODE.NOT_FOUND
        : response.status === 401
          ? STORAGE_PROVIDER_ERROR_CODE.UNAUTHORIZED
          : response.status === 403
            ? STORAGE_PROVIDER_ERROR_CODE.FORBIDDEN
            : response.status === 409
              ? STORAGE_PROVIDER_ERROR_CODE.CONFLICT
              : response.status >= 500
                ? STORAGE_PROVIDER_ERROR_CODE.UNAVAILABLE
                : STORAGE_PROVIDER_ERROR_CODE.UPSTREAM_ERROR

    throw new StorageProviderError(`S3 request failed (${response.status}): ${message.slice(0, 200)}`, {
      code: mappedCode,
      operation,
      provider: 's3'
    })
  }

  return {
    type: 's3',
    endpoint: endpointUrl.toString(),
    async putObject(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input, { requireBody: true })
        const extraHeaders = {
          ...(object.contentType ? { 'content-type': object.contentType } : {}),
          ...toS3MetadataHeaders(object.metadata)
        }
        const presigned = signPresigned({
          method: 'PUT',
          bucket: object.bucket,
          key: object.key,
          extraHeaders
        })
        const response = await requestSignedUrl(presigned, object.body, 'putObject')
        return {
          etag: response.headers.get('etag'),
          checksum: object.checksum,
          contentType: object.contentType,
          retentionClass: object.retentionClass,
          metadata: object.metadata
        }
      } catch (error) {
        throw wrapStorageError(error, { provider: 's3', operation: 'putObject' })
      }
    },
    async getObject(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        const presigned = signPresigned({ method: 'GET', bucket: object.bucket, key: object.key })
        const response = await requestSignedUrl(presigned, undefined, 'getObject')
        const body = Buffer.from(await response.arrayBuffer())
        const metadata = readS3MetadataHeaders(response.headers)
        return {
          body,
          etag: response.headers.get('etag'),
          checksum: metadata.checksum || null,
          contentType: response.headers.get('content-type') || object.contentType,
          retentionClass: metadata.retentionclass || metadata.retentionClass || null,
          metadata
        }
      } catch (error) {
        throw wrapStorageError(error, { provider: 's3', operation: 'getObject' })
      }
    },
    async createPresignedUploadUrl(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        return signPresigned({
          method: 'PUT',
          bucket: object.bucket,
          key: object.key,
          expiresInSeconds: object.expiresInSeconds || 900,
          extraHeaders: {
            ...(object.contentType ? { 'content-type': object.contentType } : {}),
            ...toS3MetadataHeaders(object.metadata)
          }
        })
      } catch (error) {
        throw wrapStorageError(error, { provider: 's3', operation: 'createPresignedUploadUrl' })
      }
    },
    async createPresignedDownloadUrl(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        return signPresigned({
          method: 'GET',
          bucket: object.bucket,
          key: object.key,
          expiresInSeconds: object.expiresInSeconds || 900
        })
      } catch (error) {
        throw wrapStorageError(error, { provider: 's3', operation: 'createPresignedDownloadUrl' })
      }
    },
    async deleteObject(input) {
      try {
        const object = normalizeStorageObjectDescriptor(input)
        const presigned = signPresigned({ method: 'DELETE', bucket: object.bucket, key: object.key })
        await requestSignedUrl(presigned, undefined, 'deleteObject', { allowMissing: true })
      } catch (error) {
        throw wrapStorageError(error, { provider: 's3', operation: 'deleteObject' })
      }
    },
    describeHealth() {
      return {
        provider: 's3',
        endpoint: endpointUrl.toString(),
        region,
        forcePathStyle,
        checkedAt: new Date().toISOString()
      }
    },
    objectUrl
  }
}
