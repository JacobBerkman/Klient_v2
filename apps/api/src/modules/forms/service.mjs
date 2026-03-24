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
  };
}
