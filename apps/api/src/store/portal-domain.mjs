import { randomUUID } from 'node:crypto'
import {
  requireFirmContext,
  validateEntityOwnership as validateTenantEntityOwnership
} from '../modules/shared/tenancy.mjs'
import {
  deleteUploadIntent,
  findPortalDraftSubmission,
  findPortalLinkRowByToken,
  getDocumentUploadRow,
  getDraftSectionState,
  getFirmRow,
  getFormSubmissionById,
  getPortalLinkRow,
  getProfileRow,
  getUploadIntent,
  listDocumentUploadRowsByFirmClient,
  listDraftSectionStates,
  listFormSubmissionsByClient,
  saveDraftSectionStateGuarded,
  upsertDocumentUploadRow,
  upsertFormSubmission,
  upsertPortalLinkRow
} from '../storage.mjs'
import { assertRequiredFieldsForSubmission, normalizeSectionIdentifier, now, requirePermission } from './helpers.mjs'

function normalizePortalScope(scope = {}) {
  return {
    templateIds: Array.isArray(scope.templateIds) ? [...new Set(scope.templateIds.filter(Boolean))] : null,
    uploadCategories: Array.isArray(scope.uploadCategories)
      ? [...new Set(scope.uploadCategories.filter(Boolean))]
      : null
  }
}

function resolvePortalLinkByToken(token) {
  const link = findPortalLinkRowByToken(token)
  if (!link) throw new Error('Portal link not found.')
  const nowMs = Date.now()
  if (link.revokedAt) throw new Error('Portal link revoked.')
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= nowMs) throw new Error('Portal link expired.')
  if (Number(link.maxUses || 0) > 0 && Number(link.usedCount || 0) >= Number(link.maxUses)) {
    throw new Error('Portal link use limit reached.')
  }
  return link
}

function assertPortalTemplateScope(link, templateId) {
  if (!Array.isArray(link.scope?.templateIds) || link.scope.templateIds.length === 0) return
  if (!link.scope.templateIds.includes(templateId)) {
    throw new Error('Portal link cannot access this form.')
  }
}

function assertPortalUploadScope(link, category) {
  if (!Array.isArray(link.scope?.uploadCategories) || link.scope.uploadCategories.length === 0) return
  if (!link.scope.uploadCategories.includes(category || 'general')) {
    throw new Error('Portal link cannot upload this category.')
  }
}

// portal_links is the source of truth now, so the consumed link (mutated
// usedCount/lastUsedAt) is written back with a targeted upsert instead of
// relying on a blob-resident reference being flushed by persist().
function consumePortalLinkUse(link) {
  link.usedCount = Number(link.usedCount || 0) + 1
  link.lastUsedAt = now()
  upsertPortalLinkRow(link)
}

function findPortalLink(token) {
  const link = findPortalLinkRowByToken(token)
  if (!link) throw new Error('Portal link not found.')
  return link
}

function findDraftForScope({ draftId, firmId, clientId }) {
  const submission = getFormSubmissionById(draftId, { firmId })
  if (!submission || submission.clientId !== clientId || submission.status !== 'draft') {
    throw new Error('Draft submission not found.')
  }
  return submission
}

export function createPortalDomain(ctx) {
  const { state, persist, objectStorage, createUploadIntent, resolveCompletionObject, normalizeMalwareScan } = ctx
  return {
    createPortalLink(user, profileId, options = {}) {
      const firmContext = requireFirmContext(user, { method: 'store.createPortalLink' })
      requirePermission(user, 'portal:manage')
      const linkedProfile = validateTenantEntityOwnership(firmContext, getProfileRow(profileId), {
        entityName: 'Profile'
      })
      // Archived profiles are not valid portal-link targets: creating live access
      // for a soft-deleted profile would contradict the archive guard that blocks
      // archiving while active links exist.
      if (linkedProfile.archivedAt) {
        const error = new Error('Cannot create a portal link for an archived profile.')
        error.statusCode = 409
        error.code = 'PROFILE_ARCHIVED'
        error.details = { profileId }
        throw error
      }
      const createdAt = now()
      const expiresAt =
        options.expiresAt || new Date(Date.now() + Number(options.expiresInHours || 24) * 3600 * 1000).toISOString()
      const maxUses = Math.max(1, Number(options.maxUses || 1))
      const link = {
        id: randomUUID(),
        firmId: user.firmId,
        profileId,
        token: randomUUID(),
        createdAt,
        expiresAt,
        maxUses,
        usedCount: 0,
        revokedAt: null,
        lastUsedAt: null,
        scope: normalizePortalScope(options.scope || options)
      }
      upsertPortalLinkRow(link)
      persist()
      return link
    },
    revokePortalLink(user, linkId) {
      const firmContext = requireFirmContext(user, { method: 'store.revokePortalLink' })
      requirePermission(user, 'portal:manage')
      const link = validateTenantEntityOwnership(firmContext, getPortalLinkRow(linkId), {
        entityName: 'Portal link'
      })
      if (!link.revokedAt) {
        link.revokedAt = now()
        upsertPortalLinkRow(link)
      }
      persist()
      return link
    },
    getPortalSession(token) {
      const link = resolvePortalLinkByToken(token)
      return {
        id: link.id,
        firmId: link.firmId,
        profileId: link.profileId,
        token: link.token,
        scope: link.scope,
        expiresAt: link.expiresAt,
        maxUses: link.maxUses,
        usedCount: link.usedCount,
        revokedAt: link.revokedAt
      }
    },
    getPortalData(token) {
      const link = resolvePortalLinkByToken(token)
      const firm = getFirmRow(link.firmId)
      const profile = getProfileRow(link.profileId, { firmId: link.firmId })
      const submissions = listFormSubmissionsByClient(link.firmId, link.profileId)
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.templateIds) ||
            link.scope.templateIds.length === 0 ||
            entry.templateId === 'portal' ||
            link.scope.templateIds.includes(entry.templateId)
        )
        .slice()
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      const availableTemplates = state.templateAggregates
        .filter((entry) => entry.firmId === link.firmId && entry.kind === 'form')
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.templateIds) ||
            link.scope.templateIds.length === 0 ||
            link.scope.templateIds.includes(entry.id)
        )
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          description: entry.description || '',
          sections: entry.formSchema?.sections || []
        }))
      const uploads = listDocumentUploadRowsByFirmClient(link.firmId, link.profileId)
        .filter(
          (entry) =>
            !Array.isArray(link.scope?.uploadCategories) ||
            link.scope.uploadCategories.length === 0 ||
            link.scope.uploadCategories.includes(entry.category || 'general')
        )
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
      return { firm, profile, submissions, availableTemplates, uploads }
    },
    portalSubmit(token, input) {
      const link = resolvePortalLinkByToken(token)
      const templateId = input.templateId || 'portal'
      const template =
        templateId === 'portal'
          ? null
          : state.templateAggregates.find(
              (entry) => entry.id === templateId && entry.firmId === link.firmId && entry.kind === 'form'
            )
      if (templateId !== 'portal' && !template) throw new Error('Form template not found.')
      if (templateId !== 'portal') assertPortalTemplateScope(link, templateId)
      const status = input.status === 'draft' ? 'draft' : 'submitted'
      if (status === 'draft') {
        const existingDraft = findPortalDraftSubmission(link.firmId, link.profileId, templateId)
        if (existingDraft) {
          // Draft saves are the hottest portal write: a targeted single-row
          // update instead of a full blob rewrite (no other state changed).
          existingDraft.data = input.data && typeof input.data === 'object' ? input.data : {}
          existingDraft.updatedAt = now()
          upsertFormSubmission(existingDraft)
          return existingDraft
        }
      }
      const portalSubmissionData = input.data && typeof input.data === 'object' ? input.data : {}
      if (status === 'submitted' && template) assertRequiredFieldsForSubmission(template, portalSubmissionData)
      const submission = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        templateId,
        status,
        data: portalSubmissionData,
        createdByUserId: null,
        createdAt: now(),
        updatedAt: now(),
        source: 'portal'
      }
      consumePortalLinkUse(link)
      upsertFormSubmission(submission)
      // persist() still runs: consumePortalLinkUse mutated the blob-backed
      // portal link (usedCount/lastUsedAt).
      persist()
      return submission
    },
    getPortalDraftSectionState(token, draftId, sectionId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      return getDraftSectionState(link.firmId, link.profileId, draftId, normalizedSectionId)
    },
    listPortalDraftSectionStates(token, draftId) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      return listDraftSectionStates(link.firmId, link.profileId, draftId)
    },
    savePortalDraftSectionState(token, draftId, sectionId, input = {}) {
      const link = findPortalLink(token)
      findDraftForScope({ draftId, firmId: link.firmId, clientId: link.profileId })
      const normalizedSectionId = normalizeSectionIdentifier(sectionId)
      // Optimistic versioning now lives in SQL: expectedVersion 0 races an
      // INSERT OR IGNORE, anything else races UPDATE ... WHERE version = ?.
      // Either way a losing writer gets the exact legacy contract back:
      // { ok: false, conflict: true, reason, state: <latest server state> }.
      // No persist(): section states live only in draft_step_states, so a
      // save is a single-row write instead of a full blob rewrite.
      const result = saveDraftSectionStateGuarded({
        firmId: link.firmId,
        clientId: link.profileId,
        draftId,
        sectionId: normalizedSectionId,
        expectedVersion: Number(input.expectedVersion || 0),
        data: input.data && typeof input.data === 'object' ? input.data : {},
        updatedAt: now()
      })
      if (!result.ok) {
        return { ok: false, conflict: true, reason: 'Section draft state is stale.', state: result.state }
      }
      return { ok: true, state: result.state }
    },
    async createPortalUploadPresign(token, input) {
      const link = resolvePortalLinkByToken(token)
      assertPortalUploadScope(link, input.category)
      const intent = createUploadIntent({
        firmId: link.firmId,
        clientId: link.profileId,
        fileName: input.fileName,
        contentType: input.contentType,
        checksum: input.checksum,
        category: input.category,
        source: 'portal',
        retentionClass: input.retentionClass
      })
      const presigned = await objectStorage.createPresignedUploadUrl({
        ...intent.object,
        expiresInSeconds: Number(input.expiresInSeconds || 900)
      })
      persist()
      return { uploadId: intent.id, object: intent.object, presigned }
    },
    portalUpload(token, input) {
      const link = resolvePortalLinkByToken(token)
      const intent = input.uploadId ? getUploadIntent(input.uploadId, link.firmId) : null
      const uploadCategory = input.category || intent?.category || 'general'
      assertPortalUploadScope(link, uploadCategory)
      const object = resolveCompletionObject({ intent, input, firmId: link.firmId })
      const malwareScan = normalizeMalwareScan(input.malwareScan)
      const upload = {
        id: randomUUID(),
        firmId: link.firmId,
        clientId: link.profileId,
        name: input.name || input.fileName || intent?.fileName || 'Portal upload',
        category: uploadCategory,
        visibility: 'shared',
        status: 'uploaded',
        uploadedBy: 'portal',
        notes: input.notes || '',
        malwareScan,
        object,
        createdAt: now(),
        updatedAt: now()
      }
      consumePortalLinkUse(link)
      if (input.uploadId) deleteUploadIntent(input.uploadId)
      upsertDocumentUploadRow(upload)
      persist()
      return upload
    },
    async createPortalUploadDownloadUrl(token, uploadId) {
      const link = resolvePortalLinkByToken(token)
      const upload = getDocumentUploadRow(uploadId, { firmId: link.firmId, clientId: link.profileId })
      if (!upload) throw new Error('Upload not found.')
      return objectStorage.createPresignedDownloadUrl({ ...upload.object, expiresInSeconds: 900 })
    }
  }
}
