import { ProfileRepository } from '../modules/profiles/repository.mjs'
import { TemplateRepository } from '../modules/templates/repository.mjs'
import { TemplatesV2Repository } from '../modules/templates-v2/repository.mjs'
import { PipelineRepository } from '../modules/pipeline/repository.mjs'
import { HouseholdsRepository } from '../modules/households/repository.mjs'
import { FormsRepository } from '../modules/forms/repository.mjs'
import { ExportsRepository } from '../modules/exports/repository.mjs'
import { AuditRepository } from '../modules/audit/repository.mjs'
import { AnalyticsRepository } from '../modules/analytics/repository.mjs'
import { PipelineStagesRepository } from '../modules/pipeline-stages/repository.mjs'
import { requireFirmContext } from '../modules/shared/tenancy.mjs'

export class StoreProfileRepository extends ProfileRepository {
  constructor(store, reads) {
    super()
    this.store = store
    this.reads = reads
  }

  listProfiles(firmContext, query) {
    const context = requireFirmContext(firmContext, { method: 'profiles.listProfiles' })
    return this.store.listProfiles(context, query?.kind, query?.search)
  }
  getProfileDetail(firmContext, profileId) {
    const context = requireFirmContext(firmContext, { method: 'profiles.getProfileDetail' })
    return {
      ...this.store.getProfileDetail(context, profileId),
      profileRecord: this.reads.getProfileDetail(context.firmId, profileId)
    }
  }
  createProfile(firmContext, input) {
    const context = requireFirmContext(firmContext, { method: 'profiles.createProfile' })
    return this.store.createProfile(context, input)
  }
  updateProfile(firmContext, profileId, patch) {
    const context = requireFirmContext(firmContext, { method: 'profiles.updateProfile' })
    return this.store.updateProfile(context, profileId, patch)
  }
  listStageHistory(firmContext, profileId) {
    const context = requireFirmContext(firmContext, { method: 'profiles.listStageHistory' })
    return this.store.listStageHistory(context, profileId)
  }
  listNotes(firmContext, profileId) {
    const context = requireFirmContext(firmContext, { method: 'profiles.listNotes' })
    return this.store.listNotes(context, profileId)
  }
  addNote(firmContext, profileId, body) {
    const context = requireFirmContext(firmContext, { method: 'profiles.addNote' })
    return this.store.addNote(context, profileId, body)
  }
  getDashboard(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'profiles.getDashboard' })
    return this.store.getDashboard(context)
  }
  getMaskedSensitiveData(firmContext, profileId, options = {}) {
    const context = requireFirmContext(firmContext, { method: 'profiles.getMaskedSensitiveData' })
    return this.store.getMaskedSensitiveData(context, profileId, options)
  }
}

export class StoreTemplateRepository extends TemplateRepository {
  constructor(store) {
    super()
    this.store = store
  }
  listDocumentTemplates(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'templates.listDocumentTemplates' })
    return this.store.listDocumentTemplates(context)
  }
  createDocumentTemplate(firmContext, input) {
    const context = requireFirmContext(firmContext, { method: 'templates.createDocumentTemplate' })
    return this.store.createDocumentTemplate(context, input)
  }
  updateTemplateMappings(user, templateId, mappings, input) {
    return this.store.updateTemplateMappings(user, templateId, mappings, input)
  }
  publishTemplate(user, templateId, input) {
    return this.store.publishTemplate(user, templateId, input)
  }
  previewTemplateMappings(user, templateId, input) {
    return this.store.previewTemplateMappings(user, templateId, input)
  }
  compareTemplateVersions(user, templateId, baseVersion, targetVersion) {
    return this.store.compareTemplateVersions(user, templateId, baseVersion, targetVersion)
  }
  revertTemplateVersion(user, templateId, targetVersion, input) {
    return this.store.revertTemplateVersion(user, templateId, targetVersion, input)
  }
  listTemplateVersions(user, templateId) {
    return this.store.listTemplateVersions(user, templateId)
  }
  listPublishTransitions(user, templateId) {
    return this.store.listPublishTransitions(user, templateId)
  }
  autoBuildTemplate(firmContext, input) {
    const context = requireFirmContext(firmContext, { method: 'templates.autoBuildTemplate' })
    return this.store.autoBuildTemplate(context, input)
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
  createClientUploadPresign(user, input) {
    return this.store.createClientUploadPresign(user, input)
  }
  createPortalLink(user, profileId, options) {
    return this.store.createPortalLink(user, profileId, options)
  }
  revokePortalLink(user, linkId) {
    return this.store.revokePortalLink(user, linkId)
  }
  getPortalSession(token) {
    return this.store.getPortalSession(token)
  }
  getPortalData(token) {
    return this.store.getPortalData(token)
  }
  createPortalUploadPresign(token, input) {
    return this.store.createPortalUploadPresign(token, input)
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
  list(firmContext) {
    return this.store.listExports(firmContext.user || firmContext)
  }
  create(firmContext, input) {
    return this.store.createExport(firmContext.user || firmContext, input)
  }
  processQueued() {
    return this.store.processQueuedExports()
  }
  retry(firmContext, exportId) {
    return this.store.retryExport(firmContext.user || firmContext, exportId)
  }
  getQueueHealth(firmContext) {
    return this.store.getExportQueueHealth(firmContext.user || firmContext)
  }
  retryFailed(firmContext, options = {}) {
    return this.store.retryFailedExports(firmContext.user || firmContext, options)
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
  getSummary(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'analytics.getSummary' })
    return this.store.getAnalytics(context)
  }
  listAuditEvents(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'analytics.listAuditEvents' })
    return this.store.listAudit(context)
  }
  listExports(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'analytics.listExports' })
    return this.store.listExports(context)
  }
}

export class StorePipelineStagesRepository extends PipelineStagesRepository {
  constructor(store) {
    super()
    this.store = store
  }
  listStages(firmContext) {
    const context = requireFirmContext(firmContext, { method: 'pipelineStages.listStages' })
    return this.store.listPipelineStages(context)
  }
  createStage(firmContext, input) {
    const context = requireFirmContext(firmContext, { method: 'pipelineStages.createStage' })
    return this.store.createPipelineStage(context, input)
  }
  updateStageMetadata(firmContext, stageId, patch) {
    const context = requireFirmContext(firmContext, { method: 'pipelineStages.updateStageMetadata' })
    return this.store.updatePipelineStageMetadata(context, stageId, patch)
  }
  deactivateStage(firmContext, stageId) {
    const context = requireFirmContext(firmContext, { method: 'pipelineStages.deactivateStage' })
    return this.store.deactivatePipelineStage(context, stageId)
  }
  reorderStages(firmContext, input) {
    const context = requireFirmContext(firmContext, { method: 'pipelineStages.reorderStages' })
    return this.store.reorderPipelineStages(context, input)
  }
}
