import { randomUUID } from 'node:crypto'
import {
  requireFirmContext,
  validateEntityOwnership as validateTenantEntityOwnership
} from '../modules/shared/tenancy.mjs'
import {
  deleteUploadIntent,
  findClientProfileRowByEmail,
  getDocumentUploadRow,
  getProfileRow,
  getUploadIntent,
  getUploadIntentById,
  insertUploadIntent,
  listDocumentUploadRowsByFirmClient,
  listFormSubmissionsByClient,
  upsertDocumentUploadRow,
  upsertFormSubmission
} from '../storage.mjs'
import { assertRequiredFieldsForSubmission, now, requirePermission, sanitizeFileName } from './helpers.mjs'

// Portal/advisor client identity resolution. Only the client-facing upload/form
// methods use it, so it lives with them. Behavior is identical to the former
// store closure function.
function requireClientProfile(user) {
  requirePermission(user, 'portal:read')
  const userEmail = String(user?.email || '').toLowerCase()
  if (!userEmail) throw new Error('Client profile not found.')
  const profile = findClientProfileRowByEmail(user.firmId, userEmail)
  if (!profile) throw new Error('Client profile not found.')
  // Archive semantics: archiving a client SUSPENDS their portal/client access.
  // findClientProfileRowByEmail is a plain email lookup that still resolves
  // archived rows (its other caller — invite-accept de-dup — needs that), so we
  // exclude archived profiles HERE, at the auth-resolution site, rather than in
  // the shared lookup. An archived client is treated as if no profile exists.
  if (profile.archivedAt) throw new Error('Client profile not found.')
  return profile
}

export function createUploadsDomain(ctx) {
  const { state, persist, addAudit, objectStorage, createUploadIntent, resolveCompletionObject, normalizeMalwareScan } =
    ctx
  return {
    getClientWorkspace(user) {
      const profile = requireClientProfile(user)
      const submissions = listFormSubmissionsByClient(user.firmId, profile.id).sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      )
      const templatesFromAggregates = state.templateAggregates
        .filter((entry) => entry.firmId === user.firmId && entry.kind === 'form')
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = listDocumentUploadRowsByFirmClient(user.firmId, profile.id).sort(
        (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      )
      const submissionByTemplate = new Map()
      submissions.forEach((submission) => {
        if (!submissionByTemplate.has(submission.templateId))
          submissionByTemplate.set(submission.templateId, submission.status)
      })
      const templateProgress = templatesFromAggregates.map((template) => ({
        templateId: template.id,
        templateName: template.name,
        status: submissionByTemplate.get(template.id) || 'not_started'
      }))
      return { profile, submissions, templates: templatesFromAggregates, templateProgress, uploads }
    },
    submitClientForm(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const template = state.templateAggregates.find(
        (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind === 'form'
      )
      if (!template) throw new Error('Form template not found.')
      const status = input.status === 'draft' ? 'draft' : 'submitted'
      const submissionData = input.data && typeof input.data === 'object' ? input.data : {}
      if (status === 'submitted') assertRequiredFieldsForSubmission(template, submissionData)
      const submission = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        templateId: input.templateId,
        status,
        data: submissionData,
        source: 'client_portal',
        createdByUserId: user.id,
        createdAt: now(),
        updatedAt: now()
      }
      upsertFormSubmission(submission)
      addAudit(user.firmId, user.id, 'form_submission', submission.id, 'client.form_submission.created', {
        templateId: input.templateId,
        status
      })
      persist()
      return submission
    },
    async createClientUploadPresign(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: profile.id,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'client',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    submitClientUpload(user, input) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const intent = input.uploadId ? getUploadIntent(input.uploadId, user.firmId) : null
      const object = resolveCompletionObject({ intent, input, firmId: user.firmId })
      const malwareScan = normalizeMalwareScan(input.malwareScan)
      const upload = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        name: input.name || input.fileName || intent?.fileName || 'Client upload',
        category: input.category || intent?.category || 'general',
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'client',
        notes: input.notes || '',
        malwareScan,
        object,
        createdAt: now(),
        updatedAt: now()
      }
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'client.document_upload.created', {
        category: upload.category,
        key: upload.object.key
      })
      persist()
      return upload
    },
    async createClientUploadDownloadUrl(user, uploadId) {
      requirePermission(user, 'client:write')
      const profile = requireClientProfile(user)
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    },
    // --- Raw binary upload endpoint (PUT /api/storage/uploads/:uploadId) ------
    // Capability-based, deliberately session-agnostic. The presign step (advisor,
    // portal, or client — all already authenticated/authorized) mints a pending
    // upload intent with an unguessable id and a reserved object key. Possessing
    // that intent id + supplying the exact reserved key IS the authorization for
    // the raw byte PUT: it works uniformly for cookie-session advisors and
    // token-only portal callers without either a session lookup or a CSRF token,
    // the same single-use-capability argument the OIDC `state` and portal tokens
    // rely on. The route is CSRF-exempt for this reason (documented in server.mjs).
    // Guards enforced here: intent exists, not expired, not already consumed
    // ('stored'), reserved key matches, recorded content-type matches (when a
    // specific one was presigned), and the byte length respects the per-flow and
    // 25 MB hard caps. Success putObject's to the reserved key and flips the
    // intent to 'stored' so the later completion POST can proceed byte-free.
    async storeUploadedBytes({ uploadId, objectKey, contentType, body } = {}) {
      const failWith = (message, statusCode) => {
        const error = new Error(message)
        error.statusCode = statusCode
        return error
      }
      if (!uploadId) throw failWith('Upload id is required.', 400)
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || [])
      const intent = getUploadIntentById(uploadId)
      if (!intent) throw failWith('Upload intent not found or already consumed.', 404)
      if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) {
        deleteUploadIntent(uploadId)
        persist()
        throw failWith('Upload intent expired.', 410)
      }
      if (intent.status === 'stored') {
        throw failWith('Upload has already been stored for this intent.', 409)
      }
      // A prior request already claimed this intent and is mid-putObject (see the
      // atomic claim below). Reject the concurrent PUT rather than double-write.
      if (intent.status === 'storing') {
        throw failWith('Upload is already being stored for this intent.', 409)
      }
      const object = intent.object || {}
      if (!object.bucket || !object.key) {
        throw failWith('Upload intent has no reserved object key.', 409)
      }
      if (objectKey && objectKey !== object.key) {
        throw failWith('Upload key does not match the reserved intent key.', 403)
      }
      // Only enforce content-type when a specific one was presigned; the generic
      // application/octet-stream default is treated as "any".
      const expectedContentType =
        object.contentType && object.contentType !== 'application/octet-stream' ? object.contentType : null
      if (expectedContentType && contentType && contentType !== expectedContentType) {
        throw failWith('Content-Type does not match the presigned upload intent.', 400)
      }
      const HARD_CAP_BYTES = 25 * 1024 * 1024
      const perFlowCap = Number(intent.maxSizeBytes) > 0 ? Number(intent.maxSizeBytes) : HARD_CAP_BYTES
      const limitBytes = Math.min(HARD_CAP_BYTES, perFlowCap)
      if (buffer.length > limitBytes) {
        throw failWith(`Upload exceeds the ${Math.floor(limitBytes / (1024 * 1024))} MB limit.`, 413)
      }
      // TOCTOU fix: claim the intent BEFORE the awaited putObject. better-sqlite3
      // is synchronous and single-writer, so the check-then-claim above runs to
      // completion with no interleaving; a second concurrent PUT that arrives
      // while this one is awaiting putObject reads status==='storing' and is
      // rejected instead of racing to a duplicate write. The cheap synchronous
      // validations above intentionally run first so a bad request never consumes
      // (and locks out) the intent.
      intent.status = 'storing'
      insertUploadIntent(intent)
      let stored
      try {
        stored = await objectStorage.putObject({
          bucket: object.bucket,
          key: object.key,
          body: buffer,
          contentType: expectedContentType || contentType || object.contentType,
          retentionClass: object.retentionClass,
          metadata: {
            fileName: intent.fileName || 'upload.bin',
            uploadIntentId: uploadId,
            source: intent.source || 'client',
            purpose: 'raw_upload'
          }
        })
      } catch (putError) {
        // Storing the bytes failed: release the claim so a legitimate retry can
        // re-attempt the PUT against the same reserved key.
        intent.status = 'pending'
        insertUploadIntent(intent)
        persist()
        throw putError
      }
      intent.status = 'stored'
      intent.storedAt = now()
      intent.storedChecksum = stored.checksum || null
      intent.storedSizeBytes = buffer.length
      insertUploadIntent(intent)
      persist()
      return {
        uploadId,
        object: { ...object, checksum: stored.checksum || object.checksum || null },
        sizeBytes: buffer.length,
        checksum: stored.checksum || null
      }
    },
    // --- Advisor-facing document uploads (profile-scoped) --------------------
    // Uploads are stored in document_uploads with clientId === profileId, the
    // same relational source of truth the portal/client flows write to. Firm
    // scoping is derived from the authenticated session user (not a portal
    // token), and each mutated row is upserted (mutation -> upsert discipline)
    // so the retention/lifecycle sweep keeps working for advisor uploads.
    listProfileUploads(user, profileId, { includeArchived = false } = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.listProfileUploads' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const uploads = listDocumentUploadRowsByFirmClient(user.firmId, profile.id)
        .filter((upload) => {
          if (upload.status === 'purged') return false
          if (!includeArchived && upload.status === 'archived') return false
          return true
        })
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      return { uploads }
    },
    async createProfileUploadPresign(user, profileId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.createProfileUploadPresign' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const intent = createUploadIntent({
        firmId: user.firmId,
        clientId: profile.id,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'advisor',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    async completeProfileUpload(user, profileId, input = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.completeProfileUpload' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const intent = input.uploadId ? getUploadIntent(input.uploadId, user.firmId) : null
      const object = resolveCompletionObject({ intent, input, firmId: user.firmId })
      // Optional inline bytes: advisors upload from the profile page, so persist
      // the payload to object storage here (server-side putObject) at the
      // intent's reserved key, which makes downloads work end-to-end without a
      // separate browser->storage PUT. The handshake shape stays identical to the
      // portal/client presign flow; only bytes are added.
      const fileBytes =
        typeof input.fileBytesBase64 === 'string' && input.fileBytesBase64
          ? Buffer.from(input.fileBytesBase64, 'base64')
          : null
      let checksum = object.checksum
      let sizeBytes = Number.isFinite(Number(input.sizeBytes)) ? Number(input.sizeBytes) : null
      if (fileBytes && fileBytes.length) {
        if (!object.bucket || !object.key) {
          throw new Error('Upload object metadata (bucket/key) is required to store file bytes.')
        }
        const stored = await objectStorage.putObject({
          bucket: object.bucket,
          key: object.key,
          body: fileBytes,
          contentType: object.contentType,
          retentionClass: object.retentionClass,
          metadata: {
            fileName: input.name || input.fileName || intent?.fileName || 'advisor-upload',
            uploadedByUserId: user.id,
            purpose: 'advisor_document_upload'
          }
        })
        checksum = stored.checksum || checksum
        sizeBytes = fileBytes.length
      } else if (intent && object.bucket && object.key) {
        // Raw-PUT completion: the browser streamed the bytes to the reserved key
        // out-of-band via PUT /api/storage/uploads/:uploadId, so no inline
        // fileBytesBase64 is present. Confirm the object actually landed (and
        // adopt its authoritative size/checksum) before recording the row —
        // completing against a missing object would create a dangling upload.
        const statResult = await objectStorage.statObject(object)
        checksum = statResult?.checksum || checksum
        if (Number.isFinite(Number(statResult?.sizeBytes))) {
          sizeBytes = Number(statResult.sizeBytes)
        }
      }
      const malwareScan = normalizeMalwareScan(input.malwareScan)
      const upload = {
        id: randomUUID(),
        firmId: user.firmId,
        clientId: profile.id,
        name: input.name || input.fileName || intent?.fileName || 'Advisor upload',
        category: input.category || intent?.category || 'general',
        visibility: 'internal',
        status: 'uploaded',
        uploadedBy: 'advisor',
        uploadedByUserId: user.id,
        notes: input.notes || '',
        sizeBytes,
        malwareScan,
        object: { ...object, checksum },
        createdAt: now(),
        updatedAt: now()
      }
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'advisor.document_upload.created', {
        category: upload.category,
        key: upload.object.key,
        profileId: profile.id
      })
      persist()
      return upload
    },
    async createProfileUploadDownload(user, profileId, uploadId) {
      const firmContext = requireFirmContext(user, { method: 'store.createProfileUploadDownload' })
      requirePermission(user, 'profiles:read')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload || upload.status === 'purged') throw new Error('Upload not found.')
      const object = upload.object || {}
      if (!object.bucket || !object.key) throw new Error('Upload has no stored object.')
      const fileName = sanitizeFileName(upload.name || `${uploadId}.bin`)
      // Mirror the export download contract: hand out a short-lived presigned
      // redirect on providers that support direct HTTP downloads (S3/MinIO), and
      // otherwise stream the bytes back through the API (local provider).
      if (
        typeof objectStorage.supportsHttpPresignedDownload === 'function' &&
        objectStorage.supportsHttpPresignedDownload()
      ) {
        try {
          await objectStorage.statObject(object)
          const presigned = await objectStorage.createPresignedDownloadUrl({
            ...object,
            expiresInSeconds: 900,
            responseContentDisposition: `attachment; filename="${fileName}"`,
            ...(object.contentType ? { responseContentType: object.contentType } : {})
          })
          return {
            redirectUrl: presigned.url,
            expiresAt: presigned.expiresAt,
            fileName: upload.name,
            contentType: object.contentType || null
          }
        } catch {
          // Presign path unavailable (e.g. object missing); fall back to streaming.
        }
      }
      const stored = await objectStorage.getObject(object)
      return {
        body: stored.body,
        fileName: upload.name,
        contentType: stored.contentType || object.contentType || 'application/octet-stream',
        sizeBytes: stored.body.length
      }
    },
    archiveProfileUpload(user, profileId, uploadId) {
      const firmContext = requireFirmContext(user, { method: 'store.archiveProfileUpload' })
      requirePermission(user, 'profiles:write')
      const profile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      const upload = getDocumentUploadRow(uploadId, { firmId: user.firmId, clientId: profile.id })
      if (!upload) throw new Error('Upload not found.')
      if (upload.status === 'archived') return upload
      // Soft delete: reuse the same 'archived' lifecycle status the retention
      // sweep assigns, so the row stays in document_uploads and keeps aging.
      upload.status = 'archived'
      upload.archivedAt = now()
      upload.updatedAt = now()
      upsertDocumentUploadRow(upload)
      addAudit(user.firmId, user.id, 'document_upload', upload.id, 'advisor.document_upload.archived', {
        key: upload.object?.key || null,
        profileId: profile.id
      })
      persist()
      return upload
    },
  }
}
