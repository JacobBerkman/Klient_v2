import test from 'node:test'
import assert from 'node:assert/strict'

import { ProfileRepository } from '../modules/profiles/repository.mjs'
import { PipelineStagesRepository } from '../modules/pipeline-stages/repository.mjs'
import { TemplateRepository } from '../modules/templates/repository.mjs'
import { TemplatesV2Repository } from '../modules/templates-v2/repository.mjs'
import {
  StoreTemplateRepository,
  StorePipelineStagesRepository,
  StoreTemplatesV2Repository
} from '../repositories/store-adapters.mjs'

function assertScaffoldError(fn, expectedMethod) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'REPOSITORY_SCAFFOLD_ONLY')
    assert.match(error.message, new RegExp(expectedMethod))
    return true
  })
}

test('repository scaffold classes throw scaffold-only errors for abstract methods', () => {
  const profileRepository = new ProfileRepository()
  assertScaffoldError(() => profileRepository.listProfiles({}, {}), 'listProfiles')
  assertScaffoldError(() => profileRepository.getProfileDetail({}, 'p1'), 'getProfileDetail')
  assertScaffoldError(() => profileRepository.createProfile({}, {}), 'createProfile')
  assertScaffoldError(() => profileRepository.updateProfile({}, 'p1', {}), 'updateProfile')
  assertScaffoldError(() => profileRepository.listNotes({}, 'p1'), 'listNotes')
  assertScaffoldError(() => profileRepository.addNote({}, 'p1', 'hello'), 'addNote')
  assertScaffoldError(() => profileRepository.getMaskedSensitiveData({}, 'p1', {}), 'getMaskedSensitiveData')
  assertScaffoldError(() => profileRepository.getCustomFieldSchema({}), 'getCustomFieldSchema')
  assertScaffoldError(() => profileRepository.createCustomField({}, {}), 'createCustomField')
  assertScaffoldError(() => profileRepository.updateCustomField({}, 'risk', {}), 'updateCustomField')
  assertScaffoldError(() => profileRepository.dryRunCustomFieldSchema({}, { rows: [] }), 'dryRunCustomFieldSchema')
  assertScaffoldError(() => profileRepository.deleteCustomField({}, 'risk'), 'deleteCustomField')

  const pipelineStagesRepository = new PipelineStagesRepository()
  assertScaffoldError(() => pipelineStagesRepository.listStages({}), 'listStages')
  assertScaffoldError(() => pipelineStagesRepository.createStage({}, {}), 'createStage')
  assertScaffoldError(() => pipelineStagesRepository.updateStageMetadata({}, 'stage-1', {}), 'updateStageMetadata')
  assertScaffoldError(() => pipelineStagesRepository.deactivateStage({}, 'stage-1'), 'deactivateStage')
  assertScaffoldError(() => pipelineStagesRepository.reorderStages({}, { stageOrder: [] }), 'reorderStages')

  const templateRepository = new TemplateRepository()
  assertScaffoldError(() => templateRepository.listDocumentTemplates({}), 'listDocumentTemplates')
  assertScaffoldError(() => templateRepository.createDocumentTemplate({}, {}), 'createDocumentTemplate')
  assertScaffoldError(() => templateRepository.updateTemplateMappings({}, 'template-1', []), 'updateTemplateMappings')
  assertScaffoldError(() => templateRepository.publishTemplate({}, 'template-1'), 'publishTemplate')
  assertScaffoldError(() => templateRepository.previewTemplateMappings({}, 'template-1', {}), 'previewTemplateMappings')
  assertScaffoldError(() => templateRepository.compareTemplateVersions({}, 'template-1', 1, 2), 'compareTemplateVersions')
  assertScaffoldError(() => templateRepository.revertTemplateVersion({}, 'template-1', 1, {}), 'revertTemplateVersion')
  assertScaffoldError(() => templateRepository.listTemplateVersions({}, 'template-1'), 'listTemplateVersions')
  assertScaffoldError(() => templateRepository.listPublishTransitions({}, 'template-1'), 'listPublishTransitions')
  assertScaffoldError(() => templateRepository.autoBuildTemplate({}, {}), 'autoBuildTemplate')

  const templatesV2Repository = new TemplatesV2Repository()
  assertScaffoldError(() => templatesV2Repository.listCanonicalTemplates({}, { kind: 'document' }), 'listCanonicalTemplates')
  assertScaffoldError(() => templatesV2Repository.createCanonicalTemplate({}, {}), 'createCanonicalTemplate')
  assertScaffoldError(() => templatesV2Repository.updateCanonicalTemplate({}, 'template-1', {}), 'updateCanonicalTemplate')
  assertScaffoldError(() => templatesV2Repository.transitionLifecycle({}, 'template-1', 'published'), 'transitionLifecycle')
})

test('store template repository forwards all reachable template methods to store', () => {
  const calls = []
  const store = {
    listDocumentTemplates: (user) => {
      calls.push(['listDocumentTemplates', user])
      return []
    },
    createDocumentTemplate: (user, input) => {
      calls.push(['createDocumentTemplate', user, input])
      return { id: 'template-1' }
    },
    updateTemplateMappings: (...args) => calls.push(['updateTemplateMappings', ...args]),
    publishTemplate: (...args) => calls.push(['publishTemplate', ...args]),
    previewTemplateMappings: (...args) => calls.push(['previewTemplateMappings', ...args]),
    compareTemplateVersions: (...args) => calls.push(['compareTemplateVersions', ...args]),
    revertTemplateVersion: (...args) => calls.push(['revertTemplateVersion', ...args]),
    listTemplateVersions: (...args) => calls.push(['listTemplateVersions', ...args]),
    listPublishTransitions: (...args) => calls.push(['listPublishTransitions', ...args]),
    autoBuildTemplate: (...args) => calls.push(['autoBuildTemplate', ...args])
  }

  const repository = new StoreTemplateRepository(store)
  const user = { firmId: 'firm-1', id: 'u1', role: 'advisor' }

  repository.listDocumentTemplates(user)
  repository.createDocumentTemplate(user, { name: 'W-9' })
  repository.updateTemplateMappings(user, 'template-1', [], { expectedVersionHash: 'abc' })
  repository.publishTemplate(user, 'template-1', { versionBump: '1.0.0', changelog: 'publish' })
  repository.previewTemplateMappings(user, 'template-1', { clientId: 'profile-1' })
  repository.compareTemplateVersions(user, 'template-1', 1, 2)
  repository.revertTemplateVersion(user, 'template-1', 1, { changelog: 'rollback' })
  repository.listTemplateVersions(user, 'template-1')
  repository.listPublishTransitions(user, 'template-1')
  repository.autoBuildTemplate(user, { fileName: 'doc.pdf' })

  assert.equal(calls.length, 10)
  assert.equal(calls[0][1].firmId, 'firm-1')
  assert.equal(calls[1][1].firmId, 'firm-1')
  assert.equal(calls[9][1].firmId, 'firm-1')
})

test('store pipeline stages repository forwards context to store layer', () => {
  const calls = []
  const repository = new StorePipelineStagesRepository({
    listPipelineStages: (firmContext) => calls.push(['list', firmContext]),
    createPipelineStage: (firmContext, input) => calls.push(['create', firmContext, input]),
    updatePipelineStageMetadata: (firmContext, stageId, patch) => calls.push(['update', firmContext, stageId, patch]),
    deactivatePipelineStage: (firmContext, stageId) => calls.push(['deactivate', firmContext, stageId]),
    reorderPipelineStages: (firmContext, input) => calls.push(['reorder', firmContext, input])
  })

  const firmContext = { firmId: 'firm-a', role: 'advisor', userId: 'u-2' }
  repository.listStages(firmContext)
  repository.createStage(firmContext, { key: 'new_stage' })
  repository.updateStageMetadata(firmContext, 'stage-1', { label: 'Updated' })
  repository.deactivateStage(firmContext, 'stage-1')
  repository.reorderStages(firmContext, { stageOrder: ['stage-1'] })

  assert.deepEqual(calls.map((entry) => entry[0]), ['list', 'create', 'update', 'deactivate', 'reorder'])
  assert.equal(calls[0][1].firmId, 'firm-a')
})

test('store templates v2 repository forwards canonical template operations', () => {
  const calls = []
  const repository = new StoreTemplatesV2Repository({
    listTemplateAggregates: (...args) => calls.push(['listTemplateAggregates', ...args]),
    createTemplateAggregate: (...args) => calls.push(['createTemplateAggregate', ...args]),
    updateTemplateAggregate: (...args) => calls.push(['updateTemplateAggregate', ...args]),
    transitionTemplateLifecycle: (...args) => calls.push(['transitionTemplateLifecycle', ...args])
  })

  const user = { firmId: 'firm-22', id: 'u22', role: 'advisor' }
  repository.listCanonicalTemplates(user, { kind: 'document' })
  repository.createCanonicalTemplate(user, { kind: 'form', name: 'Intake' })
  repository.updateCanonicalTemplate(user, 'template-22', { description: 'Updated' })
  repository.transitionLifecycle(user, 'template-22', 'archived')

  assert.deepEqual(calls.map((entry) => entry[0]), [
    'listTemplateAggregates',
    'createTemplateAggregate',
    'updateTemplateAggregate',
    'transitionTemplateLifecycle'
  ])
  assert.equal(calls[0][1].firmId, 'firm-22')
})
