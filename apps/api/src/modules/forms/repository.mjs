export class FormsRepository {
  listFormTemplates(_user) {
    throw new Error('Not implemented')
  }
  createFormTemplate(_user, _input) {
    throw new Error('Not implemented')
  }
  listFormSubmissions(_user) {
    throw new Error('Not implemented')
  }
  listFormDrafts(_user) {
    throw new Error('Not implemented')
  }
  createFormSubmission(_user, _input) {
    throw new Error('Not implemented')
  }
  updateSubmission(_user, _submissionId, _patch) {
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
  getClientWorkspace(_user) {
    throw new Error('Not implemented')
  }
  submitClientForm(_user, _input) {
    throw new Error('Not implemented')
  }
  submitClientUpload(_user, _input) {
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
