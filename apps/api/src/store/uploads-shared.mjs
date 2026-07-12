import { randomUUID } from 'node:crypto'
import { insertUploadIntent } from '../storage.mjs'
import { now, sanitizeFileName } from './helpers.mjs'

// Upload/object primitives shared by the advisor upload flows and the portal
// upload flow. They depend only on the injected objectStorage plus stateless
// helpers, so they are factored out of the store closure and handed to whichever
// domain needs them via ctx (createUploadIntent / resolveCompletionObject /
// normalizeMalwareScan). Behavior is identical to the former closure functions.
export function createUploadPrimitives({ objectStorage }) {
  function normalizeObjectMetadata(metadata = {}, defaultRetentionClass = 'uploaded_document') {
    return {
      bucket: metadata.bucket,
      key: metadata.key,
      checksum: metadata.checksum || null,
      contentType: metadata.contentType || 'application/octet-stream',
      retentionClass: metadata.retentionClass || defaultRetentionClass
    }
  }

  // Resolve the object metadata to record for an upload COMPLETION, closing the
  // caller-supplied-key trust hole. Two cases:
  //   - Intent present: the intent's reserved object (minted server-side under
  //     `${firmId}/...` at presign time) is authoritative. A caller-supplied
  //     input.object may only ECHO the reserved bucket/key (used to carry an
  //     optional checksum hint); any bucket/key divergence is a tamper attempt
  //     and is rejected. This prevents registering/downloading an object at an
  //     arbitrary key (including another firm's) via a completion call.
  //   - No intent (legacy completion): the caller supplies the whole object, so
  //     the key MUST live under the caller's own firm namespace (`${firmId}/`,
  //     the prefix createUploadIntent and every server-minted key use). This
  //     blocks writing/registering an object outside the firm's prefix.
  function resolveCompletionObject({ intent, input = {}, firmId, defaultRetentionClass = 'uploaded_document' }) {
    const reject = (message) => {
      const error = new Error(message)
      error.statusCode = 403
      error.code = 'UPLOAD_OBJECT_KEY_FORBIDDEN'
      return error
    }
    const suppliedObject = input.object || {}
    if (intent?.object?.key) {
      if (suppliedObject.key && String(suppliedObject.key) !== String(intent.object.key)) {
        throw reject('Upload object key does not match the reserved upload intent.')
      }
      if (suppliedObject.bucket && String(suppliedObject.bucket) !== String(intent.object.bucket)) {
        throw reject('Upload object bucket does not match the reserved upload intent.')
      }
      return normalizeObjectMetadata(
        // Pin bucket/key to the intent; only adopt a caller checksum hint.
        { ...intent.object, checksum: suppliedObject.checksum || intent.object.checksum || null },
        input.retentionClass || intent.object.retentionClass || defaultRetentionClass
      )
    }
    const object = normalizeObjectMetadata(suppliedObject, input.retentionClass || defaultRetentionClass)
    // The register/download hijack requires an actual key. A keyless legacy record
    // (metadata-only, no object) has nothing to register or fetch, so we leave it
    // untouched; but ANY supplied key MUST live under the caller's own firm prefix
    // (the shape createUploadIntent and every server-minted key use) so it can
    // never point at another firm's object.
    if (object.key && !String(object.key).startsWith(`${firmId}/`)) {
      throw reject('Upload object key is outside this firm’s storage namespace.')
    }
    return object
  }

  function createUploadIntent({
    firmId,
    clientId,
    fileName,
    contentType,
    checksum,
    category,
    source,
    retentionClass,
    maxSizeBytes
  }) {
    const id = randomUUID()
    const key = `${firmId}/documents/${clientId}/${Date.now()}-${id}-${sanitizeFileName(fileName || 'upload.bin')}`
    const object = normalizeObjectMetadata({
      bucket: objectStorage.bucketDocuments,
      key,
      checksum: checksum || null,
      contentType: contentType || 'application/octet-stream',
      retentionClass: retentionClass || 'uploaded_document'
    })
    const intent = {
      id,
      firmId,
      clientId,
      category: category || 'general',
      source: source || 'client',
      fileName: fileName || 'upload.bin',
      object,
      // Per-flow byte ceiling the raw upload endpoint enforces alongside the
      // global 25 MB hard cap; null means "hard cap only".
      maxSizeBytes: Number(maxSizeBytes) > 0 ? Number(maxSizeBytes) : null,
      // Raw-PUT lifecycle marker: 'pending' at presign time, flipped to 'stored'
      // once bytes land at the reserved key. A single-use guard against re-PUTs.
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    }
    // pending_upload_intents is the source of truth: targeted row insert
    // instead of pushing onto a blob-backed array.
    insertUploadIntent(intent)
    return intent
  }

  function normalizeMalwareScan(scan = {}) {
    const status = String(scan.status || 'pending').toLowerCase()
    const allowedStatus = new Set(['pending', 'clean', 'infected'])
    const normalizedStatus = allowedStatus.has(status) ? status : 'pending'
    return {
      status: normalizedStatus,
      provider: scan.provider || null,
      reference: scan.reference || null,
      checkedAt: scan.checkedAt || now()
    }
  }

  return { normalizeObjectMetadata, resolveCompletionObject, createUploadIntent, normalizeMalwareScan }
}
