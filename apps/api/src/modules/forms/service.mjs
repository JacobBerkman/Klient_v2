import { createFirmContext } from '../shared/tenancy.mjs'

export function createFormsService({ store, policy, templatesCompatibility = null }) {
  function createFormsError(message, { statusCode = 400, code = 'FORMS_VALIDATION_ERROR', details = null } = {}) {
    const error = new Error(message)
    error.statusCode = statusCode
    error.code = code
    if (details) error.details = details
    return error
  }

  function normalizeSelectorKey(value, fieldLabel) {
    if (value === undefined || value === null) {
      throw createFormsError(`${fieldLabel} is required.`, {
        code: 'FORMS_SELECTOR_REQUIRED',
        details: { field: fieldLabel, reason: 'required' }
      })
    }
    const normalized = String(value).trim()
    if (!normalized) {
      throw createFormsError(`${fieldLabel} is required.`, {
        code: 'FORMS_SELECTOR_REQUIRED',
        details: { field: fieldLabel, reason: 'blank' }
      })
    }
    return normalized
  }

  function getSubmissionOrThrow(user, submissionId) {
    const submission = store.listFormSubmissions(user).find((entry) => entry.id === submissionId)
    if (!submission) {
      throw createFormsError('Submission not found.', {
        statusCode: 404,
        code: 'FORMS_SUBMISSION_NOT_FOUND'
      })
    }
    return submission
  }

  function buildDraftConflictDetails(result = {}, draftId, fallbackSuggestion) {
    const mergePrompt = result?.mergePrompt || {}
    const type = mergePrompt.type || 'draft_conflict'
    const suggestedAction =
      type === 'lease_conflict'
        ? 'refresh_then_reacquire_lock'
        : type === 'revision_conflict'
          ? 'refresh_then_merge_changes'
          : 'refresh_then_retry'
    return {
      draftId,
      conflict: true,
      reason: result?.reason || 'Draft conflict detected.',
      type,
      localRevisionId: Number(mergePrompt.localRevisionId || 0) || null,
      serverRevisionId: Number(mergePrompt.serverRevisionId || 0) || null,
      suggestedAction,
      mergePrompt: {
        type,
        localRevisionId: Number(mergePrompt.localRevisionId || 0) || null,
        serverRevisionId: Number(mergePrompt.serverRevisionId || 0) || null,
        suggestion: mergePrompt.suggestion || fallbackSuggestion
      },
      lock: result?.lock || result?.serverDraft?.lock || null,
      serverDraft: result?.serverDraft || null
    }
  }

  function throwDraftConflict(result, draftId, { code = 'FORMS_DRAFT_CONFLICT', fallbackSuggestion } = {}) {
    throw createFormsError(result?.reason || 'Draft conflict detected.', {
      statusCode: 409,
      code,
      details: buildDraftConflictDetails(result, draftId, fallbackSuggestion)
    })
  }

  function assertSubmissionFreshness({ submission, expectedUpdatedAt, sectionKey = null, itemKey = null }) {
    const normalizedExpected = typeof expectedUpdatedAt === 'string' ? expectedUpdatedAt.trim() : ''
    if (!normalizedExpected) return
    const currentUpdatedAt = String(submission?.updatedAt || '')
    if (!currentUpdatedAt || currentUpdatedAt === normalizedExpected) return
    throw createFormsError('Submission update conflict: stale updatedAt precondition.', {
      statusCode: 409,
      code: 'FORMS_SUBMISSION_STALE',
      details: {
        conflict: true,
        submissionId: submission.id,
        expectedUpdatedAt: normalizedExpected,
        currentUpdatedAt,
        ...(sectionKey ? { sectionKey } : {}),
        ...(itemKey ? { itemKey } : {}),
        mergePrompt: {
          type: 'submission_stale',
          suggestion: 'Conflict detected: reload this draft section, review latest data, then retry your change.'
        }
      }
    })
  }

  function resolveSectionItems(submission, sectionKey) {
    const data = submission?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw createFormsError('Submission data must be an object.', {
        code: 'FORMS_SUBMISSION_DATA_INVALID',
        details: { expected: 'object' }
      })
    }
    const items = data[sectionKey]
    if (!Array.isArray(items)) {
      throw createFormsError(`Section "${sectionKey}" is not a repeater section.`, {
        code: 'FORMS_SECTION_NOT_REPEATER',
        details: { sectionKey, expected: 'array', actualType: typeof items }
      })
    }
    return items
  }

  function resolveItemIndex(items, itemKey) {
    const index = items.findIndex((item) => {
      if (!item || typeof item !== 'object') return false
      return item.id === itemKey || item.key === itemKey
    })
    if (index >= 0) return index
    const asNumber = Number(itemKey)
    if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < items.length) return asNumber
    throw createFormsError(`Repeater item "${itemKey}" not found.`, {
      statusCode: 404,
      code: 'FORMS_REPEATER_ITEM_NOT_FOUND',
      details: { itemKey }
    })
  }

  function normalizePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw createFormsError('Patch must be an object.', {
        code: 'FORMS_PATCH_INVALID',
        details: { expected: 'object' }
      })
    }
    const entries = Object.entries(patch)
    const issues = []
    if (!entries.length) {
      issues.push({ path: 'patch', message: 'Patch must include at least one field.' })
    }
    entries.forEach(([key, value]) => {
      if (!String(key || '').trim()) {
        issues.push({ path: 'patch', message: 'Patch field names must be non-empty strings.' })
      }
      if (value === undefined) {
        issues.push({ path: key || 'patch', message: 'Patch field value cannot be undefined.' })
      }
    })
    if (issues.length) {
      throw createFormsError('Patch payload is invalid.', {
        code: 'FORMS_PATCH_INVALID',
        details: { issues }
      })
    }
    return patch
  }

  function draftCollaboratorsPayload({
    action,
    draftId,
    collaborators = [],
    actorUserId = '',
    canManage = false,
    feedbackCode = '',
    message = ''
  }) {
    return {
      action,
      draftId,
      collaborators,
      collaboratorCount: collaborators.length,
      actor: {
        userId: actorUserId,
        canManage
      },
      feedback: {
        code: feedbackCode,
        message
      }
    }
  }

  function normalizeDraftCollaboratorError(error, { draftId, action, targetUserId = '' } = {}) {
    const message = String(error?.message || 'Draft collaborator request failed.')
    const lowered = message.toLowerCase()
    if (lowered.includes('draft submission not found')) {
      throw createFormsError('Draft submission not found.', {
        statusCode: 404,
        code: 'FORMS_DRAFT_COLLABORATORS_STALE_DRAFT',
        details: { action, draftId, stale: true, reason: 'draft_not_found' }
      })
    }
    if (lowered.includes('already added') || lowered.includes('already a collaborator')) {
      throw createFormsError('Collaborator already added.', {
        statusCode: 409,
        code: 'FORMS_DRAFT_COLLABORATORS_ALREADY_ADDED',
        details: { action, draftId, targetUserId, stale: true, reason: 'already_added' }
      })
    }
    if (lowered.includes('not assigned')) {
      throw createFormsError('Collaborator is already removed.', {
        statusCode: 409,
        code: 'FORMS_DRAFT_COLLABORATORS_ALREADY_REMOVED',
        details: { action, draftId, targetUserId, stale: true, reason: 'already_removed' }
      })
    }
    if (lowered.includes('owner cannot be removed')) {
      throw createFormsError('Draft owner cannot be removed as collaborator.', {
        statusCode: 409,
        code: 'FORMS_DRAFT_COLLABORATORS_OWNER_IMMUTABLE',
        details: { action, draftId, targetUserId, reason: 'owner_immutable' }
      })
    }
    throw error
  }

  return {
    listFormTemplates(user) {
      if (templatesCompatibility?.listForms) {
        return templatesCompatibility.listForms(user)
      }
      policy.requireGuard(user, 'canReadForms')
      return store.listFormTemplates(createFirmContext(user))
    },
    createFormTemplate(user, input) {
      if (templatesCompatibility?.createForm) {
        return templatesCompatibility.createForm(user, input)
      }
      policy.requireGuard(user, 'canWriteForms')
      return store.createFormTemplate(createFirmContext(user), input)
    },
    listFormSubmissions(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormSubmissions(createFirmContext(user))
    },
    listFormDrafts(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormDrafts(createFirmContext(user))
    },
    createFormSubmission(user, input) {
      policy.requireGuard(user, 'canWriteForms')
      return store.createFormSubmission(createFirmContext(user), input)
    },
    acquireDraftLock(user, draftId, input = {}) {
      policy.requireGuard(user, 'canWriteForms')
      policy.requireGuard(user, 'canWriteDraftCollaborator')
      const result = store.acquireDraftLock(createFirmContext(user), draftId, input)
      if (!result?.ok && result?.conflict) {
        throwDraftConflict(result, draftId, {
          code: 'FORMS_DRAFT_LOCK_CONFLICT',
          fallbackSuggestion: 'Draft is locked by another advisor. Refresh, then retry lock when it expires or force takeover.'
        })
      }
      return result
    },
    releaseDraftLock(user, draftId, leaseId = '') {
      policy.requireGuard(user, 'canWriteForms')
      policy.requireGuard(user, 'canWriteDraftCollaborator')
      return store.releaseDraftLock(createFirmContext(user), draftId, leaseId)
    },
    reviseDraftSubmission(user, draftId, input = {}) {
      policy.requireGuard(user, 'canWriteForms')
      policy.requireGuard(user, 'canWriteDraftCollaborator')
      const result = store.reviseDraftSubmission(createFirmContext(user), draftId, input)
      if (!result?.ok && result?.conflict) {
        throwDraftConflict(result, draftId, {
          code: 'FORMS_DRAFT_REVISE_CONFLICT',
          fallbackSuggestion: 'Another editor saved first. Refresh draft state, reconcile differences, and retry save.'
        })
      }
      return result
    },
    listDraftCollaborators(user, draftId) {
      policy.requireGuard(user, 'canManageDraftSharing')
      try {
        const collaborators = store.listDraftCollaborators(createFirmContext(user), draftId)
        return draftCollaboratorsPayload({
          action: 'list',
          draftId,
          collaborators,
          actorUserId: user.id,
          canManage: true,
          feedbackCode: 'DRAFT_COLLABORATORS_LOADED',
          message: 'Collaborator membership loaded.'
        })
      } catch (error) {
        normalizeDraftCollaboratorError(error, { draftId, action: 'list' })
      }
    },
    addDraftCollaborator(user, draftId, input = {}) {
      policy.requireGuard(user, 'canManageDraftSharing')
      const targetUserId = String(input?.userId || '').trim()
      try {
        const collaborators = store.addDraftCollaborator(createFirmContext(user), draftId, input)
        return draftCollaboratorsPayload({
          action: 'add',
          draftId,
          collaborators,
          actorUserId: user.id,
          canManage: true,
          feedbackCode: 'DRAFT_COLLABORATOR_ADDED',
          message: 'Collaborator added.'
        })
      } catch (error) {
        normalizeDraftCollaboratorError(error, { draftId, action: 'add', targetUserId })
      }
    },
    removeDraftCollaborator(user, draftId, collaboratorUserId) {
      policy.requireGuard(user, 'canManageDraftSharing')
      const targetUserId = String(collaboratorUserId || '').trim()
      try {
        const collaborators = store.removeDraftCollaborator(createFirmContext(user), draftId, collaboratorUserId)
        return draftCollaboratorsPayload({
          action: 'remove',
          draftId,
          collaborators,
          actorUserId: user.id,
          canManage: true,
          feedbackCode: 'DRAFT_COLLABORATOR_REMOVED',
          message: 'Collaborator removed.'
        })
      } catch (error) {
        normalizeDraftCollaboratorError(error, { draftId, action: 'remove', targetUserId })
      }
    },
    updateSubmission(user, submissionId, patch) {
      policy.requireGuard(user, 'canWriteForms')
      return store.updateSubmission(createFirmContext(user), submissionId, patch)
    },
    updateSubmissionSectionItem(user, submissionId, sectionKey, itemKey, patch = {}) {
      policy.requireGuard(user, 'canWriteForms')
      const normalizedSectionKey = normalizeSelectorKey(sectionKey, 'Section key')
      const normalizedItemKey = normalizeSelectorKey(itemKey, 'Item key')
      const normalizedPatch = normalizePatch(patch)
      const submission = getSubmissionOrThrow(user, submissionId)
      assertSubmissionFreshness({
        submission,
        expectedUpdatedAt: normalizedPatch.expectedUpdatedAt,
        sectionKey: normalizedSectionKey,
        itemKey: normalizedItemKey
      })
      const { expectedUpdatedAt: _ignoredExpectedUpdatedAt, ...itemPatch } = normalizedPatch
      const items = resolveSectionItems(submission, normalizedSectionKey)
      const itemIndex = resolveItemIndex(items, normalizedItemKey)
      const currentItem = items[itemIndex]
      if (!currentItem || typeof currentItem !== 'object' || Array.isArray(currentItem)) {
        throw createFormsError('Repeater item must be an object.', {
          code: 'FORMS_REPEATER_ITEM_INVALID',
          details: { sectionKey: normalizedSectionKey, itemKey: normalizedItemKey }
        })
      }
      if ('id' in itemPatch || 'key' in itemPatch) {
        throw createFormsError('Item identity fields (id/key) cannot be updated.', {
          code: 'FORMS_REPEATER_IDENTITY_IMMUTABLE',
          details: { immutableFields: ['id', 'key'] }
        })
      }
      const nextItem = { ...currentItem, ...itemPatch }
      const nextItems = items.map((entry, index) => (index === itemIndex ? nextItem : entry))
      const nextData = { ...submission.data, [normalizedSectionKey]: nextItems }
      return store.updateSubmission(user, submissionId, {
        data: nextData,
        auditContext: {
          action: 'form_submission.repeater_item_updated',
          sectionKey: normalizedSectionKey,
          itemKey: normalizedItemKey
        }
      })
    },
    deleteSubmissionSectionItem(user, submissionId, sectionKey, itemKey, options = {}) {
      policy.requireGuard(user, 'canWriteForms')
      const normalizedSectionKey = normalizeSelectorKey(sectionKey, 'Section key')
      const normalizedItemKey = normalizeSelectorKey(itemKey, 'Item key')
      const submission = getSubmissionOrThrow(user, submissionId)
      assertSubmissionFreshness({
        submission,
        expectedUpdatedAt: options?.expectedUpdatedAt,
        sectionKey: normalizedSectionKey,
        itemKey: normalizedItemKey
      })
      const items = resolveSectionItems(submission, normalizedSectionKey)
      const itemIndex = resolveItemIndex(items, normalizedItemKey)
      const nextItems = items.filter((_entry, index) => index !== itemIndex)
      const nextData = { ...submission.data, [normalizedSectionKey]: nextItems }
      return store.updateSubmission(user, submissionId, {
        data: nextData,
        auditContext: {
          action: 'form_submission.repeater_item_deleted',
          sectionKey: normalizedSectionKey,
          itemKey: normalizedItemKey
        }
      })
    },
    deleteSubmission(user, submissionId) {
      policy.requireGuard(user, 'canWriteForms')
      return store.deleteSubmission(createFirmContext(user), submissionId)
    },
    getClientWorkspace(user) {
      policy.requireGuard(user, 'canReadClientWorkspace')
      return store.getClientWorkspace(user)
    },
    submitClientForm(user, input) {
      policy.requireGuard(user, 'canWriteClientWorkspace')
      return store.submitClientForm(user, input)
    },
    submitClientUpload(user, input) {
      policy.requireGuard(user, 'canWriteClientWorkspace')
      return store.submitClientUpload(user, input)
    },
    createClientUploadPresign(user, input) {
      policy.requireGuard(user, 'canWriteClientWorkspace')
      return store.createClientUploadPresign(user, input)
    },
    // Capability-based raw byte upload: authorized purely by possession of a live
    // upload intent id + matching reserved key (see store.storeUploadedBytes and
    // the CSRF-exemption note in server.mjs). No session/policy guard here — the
    // presign step that minted the intent already enforced firm scope + auth, and
    // portal-token callers legitimately have no session to guard against.
    storeUploadedBytes(input) {
      return store.storeUploadedBytes(input)
    },
    // Advisor-facing, profile-scoped document uploads. Guarded like profile
    // notes (read/write on profiles); the store applies firm scoping from the
    // session user and re-checks the profiles:read/write permission.
    listProfileUploads(user, profileId, options = {}) {
      policy.requireGuard(user, 'canReadProfiles')
      return store.listProfileUploads(user, profileId, options)
    },
    createProfileUploadPresign(user, profileId, input) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.createProfileUploadPresign(user, profileId, input)
    },
    completeProfileUpload(user, profileId, input) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.completeProfileUpload(user, profileId, input)
    },
    getProfileUploadDownload(user, profileId, uploadId) {
      policy.requireGuard(user, 'canReadProfiles')
      return store.createProfileUploadDownload(user, profileId, uploadId)
    },
    archiveProfileUpload(user, profileId, uploadId) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.archiveProfileUpload(user, profileId, uploadId)
    },
    createPortalLink(user, profileId, options) {
      policy.requireGuard(user, 'canCreatePortalLink')
      return store.createPortalLink(user, profileId, options)
    },
    revokePortalLink(user, linkId) {
      policy.requireGuard(user, 'canCreatePortalLink')
      return store.revokePortalLink(user, linkId)
    },
    getPortalSession(token) {
      return store.getPortalSession(token)
    },
    createPortalUploadPresign(token, input) {
      return store.createPortalUploadPresign(token, input)
    },
    getPortalData(token) {
      return store.getPortalData(token)
    },
    portalSubmit(token, input) {
      return store.portalSubmit(token, input)
    },
    portalUpload(token, input) {
      return store.portalUpload(token, input)
    },
    getPortalDraftSectionState(token, draftId, sectionId) {
      return store.getPortalDraftSectionState(token, draftId, sectionId)
    },
    listPortalDraftSectionStates(token, draftId) {
      return store.listPortalDraftSectionStates(token, draftId)
    },
    savePortalDraftSectionState(token, draftId, sectionId, input) {
      return store.savePortalDraftSectionState(token, draftId, sectionId, input)
    }
  }
}
