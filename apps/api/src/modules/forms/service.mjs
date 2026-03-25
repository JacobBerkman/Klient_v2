import { createFirmContext } from '../shared/tenancy.mjs'

export function createFormsService({ store, policy, templatesCompatibility = null }) {
  function getSubmissionOrThrow(user, submissionId) {
    const submission = store.listFormSubmissions(user).find((entry) => entry.id === submissionId)
    if (!submission) throw new Error('Submission not found.')
    return submission
  }

  function resolveSectionItems(submission, sectionKey) {
    const data = submission?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Submission data must be an object.')
    }
    const items = data[sectionKey]
    if (!Array.isArray(items)) throw new Error(`Section "${sectionKey}" is not a repeater section.`)
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
    throw new Error(`Repeater item "${itemKey}" not found.`)
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
      if (!sectionKey) throw new Error('Section key is required.')
      if (!itemKey) throw new Error('Item key is required.')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Patch must be an object.')
      }
      const submission = getSubmissionOrThrow(user, submissionId)
      const items = resolveSectionItems(submission, sectionKey)
      const itemIndex = resolveItemIndex(items, itemKey)
      const currentItem = items[itemIndex]
      if (!currentItem || typeof currentItem !== 'object' || Array.isArray(currentItem)) {
        throw new Error('Repeater item must be an object.')
      }
      if ('id' in patch || 'key' in patch) {
        throw new Error('Item identity fields (id/key) cannot be updated.')
      }
      const nextItem = { ...currentItem, ...patch }
      const nextItems = items.map((entry, index) => (index === itemIndex ? nextItem : entry))
      const nextData = { ...submission.data, [sectionKey]: nextItems }
      return store.updateSubmission(user, submissionId, {
        data: nextData,
        auditContext: {
          action: 'form_submission.repeater_item_updated',
          sectionKey,
          itemKey
        }
      })
    },
    deleteSubmissionSectionItem(user, submissionId, sectionKey, itemKey) {
      policy.requireGuard(user, 'canWriteForms')
      if (!sectionKey) throw new Error('Section key is required.')
      if (!itemKey) throw new Error('Item key is required.')
      const submission = getSubmissionOrThrow(user, submissionId)
      const items = resolveSectionItems(submission, sectionKey)
      const itemIndex = resolveItemIndex(items, itemKey)
      const nextItems = items.filter((_entry, index) => index !== itemIndex)
      const nextData = { ...submission.data, [sectionKey]: nextItems }
      return store.updateSubmission(user, submissionId, {
        data: nextData,
        auditContext: {
          action: 'form_submission.repeater_item_deleted',
          sectionKey,
          itemKey
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
