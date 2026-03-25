import { createFirmContext } from '../shared/tenancy.mjs'

export function createPipelineStagesService({ pipelineStagesRepository, policy }) {
  return {
    listStages(user) {
      policy.requireGuard(user, 'canReadPipeline')
      return pipelineStagesRepository.listStages(createFirmContext(user))
    },
    createStage(user, input) {
      policy.requireGuard(user, 'canMovePipeline')
      return pipelineStagesRepository.createStage(createFirmContext(user), input)
    },
    updateStageMetadata(user, stageId, patch) {
      policy.requireGuard(user, 'canMovePipeline')
      return pipelineStagesRepository.updateStageMetadata(createFirmContext(user), stageId, patch)
    },
    deactivateStage(user, stageId) {
      policy.requireGuard(user, 'canMovePipeline')
      return pipelineStagesRepository.deactivateStage(createFirmContext(user), stageId)
    },
    reorderStages(user, input) {
      policy.requireGuard(user, 'canMovePipeline')
      return pipelineStagesRepository.reorderStages(createFirmContext(user), input)
    }
  }
}
