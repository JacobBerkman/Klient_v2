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
      const items = resolveSectionItems(submission, normalizedSectionKey)
      const itemIndex = resolveItemIndex(items, normalizedItemKey)
      const currentItem = items[itemIndex]
      if (!currentItem || typeof currentItem !== 'object' || Array.isArray(currentItem)) {
        throw createFormsError('Repeater item must be an object.', {
          code: 'FORMS_REPEATER_ITEM_INVALID',
          details: { sectionKey: normalizedSectionKey, itemKey: normalizedItemKey }
        })
      }
      if ('id' in normalizedPatch || 'key' in normalizedPatch) {
        throw createFormsError('Item identity fields (id/key) cannot be updated.', {
          code: 'FORMS_REPEATER_IDENTITY_IMMUTABLE',
          details: { immutableFields: ['id', 'key'] }
        })
      }
      const nextItem = { ...currentItem, ...normalizedPatch }
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
    deleteSubmissionSectionItem(user, submissionId, sectionKey, itemKey) {
      policy.requireGuard(user, 'canWriteForms')
      const normalizedSectionKey = normalizeSelectorKey(sectionKey, 'Section key')
      const normalizedItemKey = normalizeSelectorKey(itemKey, 'Item key')
      const submission = getSubmissionOrThrow(user, submissionId)
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
