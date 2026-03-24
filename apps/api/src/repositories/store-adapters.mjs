import { ProfileRepository } from '../modules/profiles/repository.mjs';
import { TemplateRepository } from '../modules/templates/repository.mjs';

export class StoreProfileRepository extends ProfileRepository {
  constructor(store, reads) {
    super();
    this.store = store;
    this.reads = reads;
  }

  listProfiles(user, query) {
    return this.reads.listProfiles(user.firmId, query);
  }

  getProfileDetail(user, profileId) {
    return {
      ...this.store.getProfileDetail(user, profileId),
      profileRecord: this.reads.getProfileDetail(user.firmId, profileId)
    };
  }

  createProfile(user, input) { return this.store.createProfile(user, input); }
  updateProfile(user, profileId, patch) { return this.store.updateProfile(user, profileId, patch); }
  listStageHistory(user, profileId) { return this.store.listStageHistory(user, profileId); }
  listNotes(user, profileId) { return this.store.listNotes(user, profileId); }
  addNote(user, profileId, body) { return this.store.addNote(user, profileId, body); }
  getDashboard(user) { return this.store.getDashboard(user); }
  getMaskedSensitiveData(user, profileId) { return this.store.getMaskedSensitiveData(user, profileId); }
}

export class StoreTemplateRepository extends TemplateRepository {
  constructor(store) {
    super();
    this.store = store;
  }

  listDocumentTemplates(user) { return this.store.listDocumentTemplates(user); }
  createDocumentTemplate(user, input) { return this.store.createDocumentTemplate(user, input); }
  updateTemplateMappings(user, templateId, mappings) { return this.store.updateTemplateMappings(user, templateId, mappings); }
  publishTemplate(user, templateId) { return this.store.publishTemplate(user, templateId); }
  autoBuildTemplate(user, input) { return this.store.autoBuildTemplate(user, input); }
}
