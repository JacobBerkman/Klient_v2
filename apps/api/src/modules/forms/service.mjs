export function createFormsService({ store, policy }) {
  return {
    listFormTemplates(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormTemplates(user)
    },
    createFormTemplate(user, input) {
      policy.requireGuard(user, 'canWriteForms')
      return store.createFormTemplate(user, input)
    },
    listFormSubmissions(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormSubmissions(user)
    },
    listFormDrafts(user) {
      policy.requireGuard(user, 'canReadForms')
      return store.listFormDrafts(user)
    },
    createFormSubmission(user, input) {
      policy.requireGuard(user, 'canWriteForms')
      return store.createFormSubmission(user, input)
    },
    updateSubmission(user, submissionId, patch) {
      policy.requireGuard(user, 'canWriteForms')
      return store.updateSubmission(user, submissionId, patch)
    },
    deleteSubmission(user, submissionId) {
      policy.requireGuard(user, 'canWriteForms')
      return store.deleteSubmission(user, submissionId)
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
    }
  }
}
