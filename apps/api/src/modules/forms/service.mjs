export function createFormsService({ store }) {
  return {
    listFormTemplates(user) { return store.listFormTemplates(user); },
    createFormTemplate(user, input) { return store.createFormTemplate(user, input); },
    listFormSubmissions(user) { return store.listFormSubmissions(user); },
    listFormDrafts(user) { return store.listFormDrafts(user); },
    createFormSubmission(user, input) { return store.createFormSubmission(user, input); },
    updateSubmission(user, submissionId, patch) { return store.updateSubmission(user, submissionId, patch); },
    deleteSubmission(user, submissionId) { return store.deleteSubmission(user, submissionId); },
    getClientWorkspace(user) { return store.getClientWorkspace(user); },
    submitClientForm(user, input) { return store.submitClientForm(user, input); },
    submitClientUpload(user, input) { return store.submitClientUpload(user, input); },
    createPortalLink(user, profileId) { return store.createPortalLink(user, profileId); },
    getPortalData(token) { return store.getPortalData(token); },
    portalSubmit(token, input) { return store.portalSubmit(token, input); },
    portalUpload(token, input) { return store.portalUpload(token, input); }
  };
}
