import { ProfileRepository } from '../modules/profiles/repository.mjs'
import { TemplateRepository } from '../modules/templates/repository.mjs'
import { PipelineRepository } from '../modules/pipeline/repository.mjs'
import { HouseholdsRepository } from '../modules/households/repository.mjs'
import { FormsRepository } from '../modules/forms/repository.mjs'
import { ExportsRepository } from '../modules/exports/repository.mjs'
import { AuditRepository } from '../modules/audit/repository.mjs'
import { AnalyticsRepository } from '../modules/analytics/repository.mjs'
import { TemplatesV2Repository } from '../modules/templates-v2/repository.mjs'

export class StoreProfileRepository extends ProfileRepository {
  constructor(store, reads) {
    super()
    this.store = store
    this.reads = reads
  }

  listProfiles(user, query) {
    return this.reads.listProfiles(user.firmId, query)
  }
  getProfileDetail(user, profileId) {
    return {
      ...this.store.getProfileDetail(user, profileId),
      profileRecord: this.reads.getProfileDetail(user.firmId, profileId)
    }
  }
  createProfile(user, input) {
    return this.store.createProfile(user, input)
  }
  updateProfile(user, profileId, patch) {
    return this.store.updateProfile(user, profileId, patch)
  }
  listStageHistory(user, profileId) {
    return this.store.listStageHistory(user, profileId)
  }
  listNotes(user, profileId) {
    return this.store.listNotes(user, profileId)
  }
  addNote(user, profileId, body) {
    return this.store.addNote(user, profileId, body)
  }
  getDashboard(user) {
    return this.store.getDashboard(user)
  }
  getMaskedSensitiveData(user, profileId, options = {}) {
    return this.store.getMaskedSensitiveData(user, profileId, options)
  }
}

export class StoreTemplateRepository extends TemplateRepository {
  constructor(store) {
    super()
    this.store = store
  }
  listDocumentTemplates(user) {
    return this.store.listDocumentTemplates(user)
  }
  createDocumentTemplate(user, input) {
    return this.store.createDocumentTemplate(user, input)
  }
  updateTemplateMappings(user, templateId, mappings) {
    return this.store.updateTemplateMappings(user, templateId, mappings)
  }
  publishTemplate(user, templateId) {
    return this.store.publishTemplate(user, templateId)
  }
  autoBuildTemplate(user, input) {
    return this.store.autoBuildTemplate(user, input)
  }
}

export class StoreTemplatesV2Repository extends TemplatesV2Repository {
  constructor(store) {
    super()
    this.store = store
  }
  listCanonicalTemplates(user, filters = {}) {
    return this.store.listTemplateAggregates(user, filters)
  }
  createCanonicalTemplate(user, input) {
    return this.store.createTemplateAggregate(user, input)
  }
  updateCanonicalTemplate(user, templateId, patch) {
    return this.store.updateTemplateAggregate(user, templateId, patch)
  }
  transitionLifecycle(user, templateId, nextState) {
    return this.store.transitionTemplateLifecycle(user, templateId, nextState)
  }
}

export class StorePipelineRepository extends PipelineRepository {
  constructor(store) {
    super()
    this.store = store
  }
  getBoard(user) {
    return this.store.getBoard(user)
  }
  reorderBoard(user, input) {
    return this.store.reorderBoard(user, input)
  }
  normalizeBoardOrdering(user) {
    return this.store.normalizeBoardOrdering(user)
  }
}

export class StoreHouseholdsRepository extends HouseholdsRepository {
  constructor(store) {
    super()
    this.store = store
  }
  listHouseholds(user) {
    return this.store.listHouseholds(user)
  }
  createHousehold(user, input) {
    return this.store.createHousehold(user, input)
  }
  addHouseholdMember(user, householdId, input) {
    return this.store.addHouseholdMember(user, householdId, input)
  }
  removeHouseholdMember(user, householdId, clientId) {
    return this.store.removeHouseholdMember(user, householdId, clientId)
  }
  linkSpouse(user, primaryClientId, spouseClientId) {
    return this.store.linkSpouse(user, primaryClientId, spouseClientId)
  }
  createSpouse(user, primaryClientId, spouse) {
    return this.store.createSpouse(user, primaryClientId, spouse)
  }
}

export class StoreFormsRepository extends FormsRepository {
  constructor(store) {
    super()
    this.store = store
  }
  listFormTemplates(user) {
    return this.store.listFormTemplates(user)
  }
  createFormTemplate(user, input) {
    return this.store.createFormTemplate(user, input)
  }
  listFormSubmissions(user) {
    return this.store.listFormSubmissions(user)
  }
  listFormDrafts(user) {
    return this.store.listFormDrafts(user)
  }
  createFormSubmission(user, input) {
    return this.store.createFormSubmission(user, input)
  }
  updateSubmission(user, submissionId, patch) {
    return this.store.updateSubmission(user, submissionId, patch)
  }
  deleteSubmission(user, submissionId) {
    return this.store.deleteSubmission(user, submissionId)
  }
  getClientWorkspace(user) {
    return this.store.getClientWorkspace(user)
  }
  submitClientForm(user, input) {
    return this.store.submitClientForm(user, input)
  }
  submitClientUpload(user, input) {
    return this.store.submitClientUpload(user, input)
  }
  createPortalLink(user, profileId) {
    return this.store.createPortalLink(user, profileId)
  }
  getPortalData(token) {
    return this.store.getPortalData(token)
  }
  portalSubmit(token, input) {
    return this.store.portalSubmit(token, input)
  }
  portalUpload(token, input) {
    return this.store.portalUpload(token, input)
  }
}

export class StoreExportsRepository extends ExportsRepository {
  constructor(store) {
    super()
    this.store = store
  }
  list(user) {
    return this.store.listExports(user)
  }
  create(user, input) {
    return this.store.createExport(user, input)
  }
  processQueued() {
    return this.store.processQueuedExports()
  }
  retry(user, exportId) {
    return this.store.retryExport(user, exportId)
  }
}

export class StoreAuditRepository extends AuditRepository {
  constructor(store) {
    super()
    this.store = store
  }
  list(user) {
    return this.store.listAudit(user)
  }
}

export class StoreAnalyticsRepository extends AnalyticsRepository {
  constructor(store, reads) {
    super()
    this.store = store
    this.reads = reads
  }
  getStageCounts(firmId) {
    return this.reads.getAnalytics(firmId)
  }
  getSummary(user) {
    return this.store.getAnalytics(user)
  }
  listAuditEvents(user) {
    return this.store.listAudit(user)
  }
  listExports(user) {
    return this.store.listExports(user)
  }
}
