import { throwRepositoryScaffoldError } from '../shared/repository-scaffold.mjs'

export class ProfileRepository {
  listProfiles(_firmContext, _query) {
    throwRepositoryScaffoldError('ProfileRepository', 'listProfiles')
  }
  getProfileDetail(_firmContext, _profileId) {
    throwRepositoryScaffoldError('ProfileRepository', 'getProfileDetail')
  }
  createProfile(_firmContext, _input) {
    throwRepositoryScaffoldError('ProfileRepository', 'createProfile')
  }
  updateProfile(_firmContext, _profileId, _patch) {
    throwRepositoryScaffoldError('ProfileRepository', 'updateProfile')
  }
  addTag(_firmContext, _profileId, _tag) {
    throwRepositoryScaffoldError('ProfileRepository', 'addTag')
  }
  removeTag(_firmContext, _profileId, _tag) {
    throwRepositoryScaffoldError('ProfileRepository', 'removeTag')
  }
  listNotes(_firmContext, _profileId) {
    throwRepositoryScaffoldError('ProfileRepository', 'listNotes')
  }
  addNote(_firmContext, _profileId, _body) {
    throwRepositoryScaffoldError('ProfileRepository', 'addNote')
  }
  getMaskedSensitiveData(_firmContext, _profileId, _options = {}) {
    throwRepositoryScaffoldError('ProfileRepository', 'getMaskedSensitiveData')
  }
  getCustomFieldSchema(_firmContext) {
    throwRepositoryScaffoldError('ProfileRepository', 'getCustomFieldSchema')
  }
  createCustomField(_firmContext, _input) {
    throwRepositoryScaffoldError('ProfileRepository', 'createCustomField')
  }
  updateCustomField(_firmContext, _fieldKey, _patch) {
    throwRepositoryScaffoldError('ProfileRepository', 'updateCustomField')
  }
  dryRunCustomFieldSchema(_firmContext, _input) {
    throwRepositoryScaffoldError('ProfileRepository', 'dryRunCustomFieldSchema')
  }
  deleteCustomField(_firmContext, _fieldKey) {
    throwRepositoryScaffoldError('ProfileRepository', 'deleteCustomField')
  }
}
