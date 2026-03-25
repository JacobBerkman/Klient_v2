import { createFirmContext } from '../shared/tenancy.mjs'

export function createFormsService({ store, policy }) {
  return {
    listFormTemplates(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormTemplates(createFirmContext(user))
    },
    createFormTemplate(user, input) {
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
    deleteSubmission(user, submissionId) {
      policy.requireGuard(user, 'canWriteForms')
      return store.deleteSubmission(createFirmContext(user), submissionId)
    },
    getClientWorkspace(user) {
      policy.requireGuard(user, 'canReadClientWorkspace')
      return store.getClientWorkspace(createFirmContext(user))
    },
    submitClientForm(user, input) {
      policy.requireGuard(user, 'canWriteClientWorkspace')
      return store.submitClientForm(createFirmContext(user), input)
    },
    submitClientUpload(user, input) {
      policy.requireGuard(user, 'canWriteClientWorkspace')
      return store.submitClientUpload(createFirmContext(user), input)
    },
    createPortalLink(user, profileId) {
      policy.requireGuard(user, 'canCreatePortalLink')
      return store.createPortalLink(createFirmContext(user), profileId)
    },
    getPortalData(token) {
      return store.getPortalData(token)
    },
    portalSubmit(token, input) {
      return store.portalSubmit(token, input)
    },
    portalUpload(token, input) {
      return store.portalUpload(token, input)
    }
  }
}
