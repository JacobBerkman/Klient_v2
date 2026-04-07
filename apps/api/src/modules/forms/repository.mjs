export class FormsRepository {
  listFormTemplates(_firmContext) {
    throw new Error('Not implemented')
  }
  createFormTemplate(_firmContext, _input) {
    throw new Error('Not implemented')
  }
  listFormSubmissions(_firmContext) {
    throw new Error('Not implemented')
  }
  listFormDrafts(_firmContext) {
    throw new Error('Not implemented')
  }
  createFormSubmission(_firmContext, _input) {
    throw new Error('Not implemented')
  }
  acquireDraftLock(_firmContext, _submissionId, _input) {
    throw new Error('Not implemented')
  }
  releaseDraftLock(_firmContext, _submissionId, _leaseId) {
    throw new Error('Not implemented')
  }
  reviseDraftSubmission(_firmContext, _submissionId, _input) {
    throw new Error('Not implemented')
  }
  listDraftCollaborators(_firmContext, _submissionId) {
    throw new Error('Not implemented')
  }
  addDraftCollaborator(_firmContext, _submissionId, _input) {
    throw new Error('Not implemented')
  }
  removeDraftCollaborator(_firmContext, _submissionId, _collaboratorUserId) {
    throw new Error('Not implemented')
  }
  updateSubmission(_firmContext, _submissionId, _patch) {
    throw new Error('Not implemented')
  }
  updateSubmissionSectionItem(_user, _submissionId, _sectionKey, _itemKey, _patch) {
    throw new Error('Not implemented')
  }
  deleteSubmissionSectionItem(_user, _submissionId, _sectionKey, _itemKey) {
    throw new Error('Not implemented')
  }
  deleteSubmission(_user, _submissionId) {
    throw new Error('Not implemented')
  }
  getClientWorkspace(_firmContext) {
    throw new Error('Not implemented')
  }
  submitClientForm(_firmContext, _input) {
    throw new Error('Not implemented')
  }
  submitClientUpload(_firmContext, _input) {
    throw new Error('Not implemented')
  }
  createClientUploadPresign(_user, _input) {
    throw new Error('Not implemented')
  }
  createPortalLink(_user, _profileId, _options) {
    throw new Error('Not implemented')
  }
  revokePortalLink(_user, _linkId) {
    throw new Error('Not implemented')
  }
  getPortalSession(_token) {
    throw new Error('Not implemented')
  }
  getPortalData(_token) {
    throw new Error('Not implemented')
  }
  createPortalUploadPresign(_token, _input) {
    throw new Error('Not implemented')
  }
  portalSubmit(_token, _input) {
    throw new Error('Not implemented')
  }
  portalUpload(_token, _input) {
    throw new Error('Not implemented')
  }
  getPortalDraftSectionState(_token, _draftId, _sectionId) {
    throw new Error('Not implemented')
  }
  listPortalDraftSectionStates(_token, _draftId) {
    throw new Error('Not implemented')
  }
  savePortalDraftSectionState(_token, _draftId, _sectionId, _input) {
    throw new Error('Not implemented')
  }
}
