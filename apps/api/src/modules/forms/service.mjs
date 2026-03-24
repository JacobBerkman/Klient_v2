export function createFormsService({ formsRepository }) {
  return {
    listFormTemplates(user) { return formsRepository.listFormTemplates(user); },
    createFormTemplate(user, input) { return formsRepository.createFormTemplate(user, input); },
    listFormSubmissions(user) { return formsRepository.listFormSubmissions(user); },
    listFormDrafts(user) { return formsRepository.listFormDrafts(user); },
    createFormSubmission(user, input) { return formsRepository.createFormSubmission(user, input); },
    updateSubmission(user, submissionId, patch) { return formsRepository.updateSubmission(user, submissionId, patch); },
    deleteSubmission(user, submissionId) { return formsRepository.deleteSubmission(user, submissionId); },
    getClientWorkspace(user) { return formsRepository.getClientWorkspace(user); },
    submitClientForm(user, input) { return formsRepository.submitClientForm(user, input); },
    submitClientUpload(user, input) { return formsRepository.submitClientUpload(user, input); },
    createPortalLink(user, profileId) { return formsRepository.createPortalLink(user, profileId); },
    getPortalData(token) { return formsRepository.getPortalData(token); },
    portalSubmit(token, input) { return formsRepository.portalSubmit(token, input); },
    portalUpload(token, input) { return formsRepository.portalUpload(token, input); }
export function createFormsService({ store, policy }) {
  return {
    listFormTemplates(user) { policy.requireGuard(user, 'canReadForms'); return store.listFormTemplates(user); },
    createFormTemplate(user, input) { policy.requireGuard(user, 'canWriteForms'); return store.createFormTemplate(user, input); },
    listFormSubmissions(user) { policy.requireGuard(user, 'canReadForms'); return store.listFormSubmissions(user); },
    listFormDrafts(user) { policy.requireGuard(user, 'canReadForms'); return store.listFormDrafts(user); },
    createFormSubmission(user, input) { policy.requireGuard(user, 'canWriteForms'); return store.createFormSubmission(user, input); },
    updateSubmission(user, submissionId, patch) { policy.requireGuard(user, 'canWriteForms'); return store.updateSubmission(user, submissionId, patch); },
    deleteSubmission(user, submissionId) { policy.requireGuard(user, 'canWriteForms'); return store.deleteSubmission(user, submissionId); },
    getClientWorkspace(user) { policy.requireGuard(user, 'canReadClientWorkspace'); return store.getClientWorkspace(user); },
    submitClientForm(user, input) { policy.requireGuard(user, 'canWriteClientWorkspace'); return store.submitClientForm(user, input); },
    submitClientUpload(user, input) { policy.requireGuard(user, 'canWriteClientWorkspace'); return store.submitClientUpload(user, input); },
    createPortalLink(user, profileId) { policy.requireGuard(user, 'canCreatePortalLink'); return store.createPortalLink(user, profileId); },
    getPortalData(token) { return store.getPortalData(token); },
    portalSubmit(token, input) { return store.portalSubmit(token, input); },
    portalUpload(token, input) { return store.portalUpload(token, input); }
  };
}
