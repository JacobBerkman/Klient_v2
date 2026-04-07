export class ProfileRepository {
  listProfiles(_firmContext, _query) {
    throw new Error('ProfileRepository.listProfiles not implemented')
  }
  getProfileDetail(_firmContext, _profileId) {
    throw new Error('ProfileRepository.getProfileDetail not implemented')
  }
  createProfile(_firmContext, _input) {
    throw new Error('ProfileRepository.createProfile not implemented')
  }
  updateProfile(_firmContext, _profileId, _patch) {
    throw new Error('ProfileRepository.updateProfile not implemented')
  }
  listNotes(_firmContext, _profileId) {
    throw new Error('ProfileRepository.listNotes not implemented')
  }
  addNote(_firmContext, _profileId, _body) {
    throw new Error('ProfileRepository.addNote not implemented')
  }
  getMaskedSensitiveData(_firmContext, _profileId, _options = {}) {
    throw new Error('ProfileRepository.getMaskedSensitiveData not implemented')
  }
  getCustomFieldSchema(_firmContext) {
    throw new Error('ProfileRepository.getCustomFieldSchema not implemented')
  }
  createCustomField(_firmContext, _input) {
    throw new Error('ProfileRepository.createCustomField not implemented')
  }
  updateCustomField(_firmContext, _fieldKey, _patch) {
    throw new Error('ProfileRepository.updateCustomField not implemented')
  }
  deleteCustomField(_firmContext, _fieldKey) {
    throw new Error('ProfileRepository.deleteCustomField not implemented')
  }
}
