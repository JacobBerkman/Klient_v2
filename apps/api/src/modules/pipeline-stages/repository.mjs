import { throwRepositoryScaffoldError } from '../shared/repository-scaffold.mjs'

export class PipelineStagesRepository {
  listStages(_firmContext) {
    throwRepositoryScaffoldError('PipelineStagesRepository', 'listStages')
  }
  createStage(_firmContext, _input) {
    throwRepositoryScaffoldError('PipelineStagesRepository', 'createStage')
  }
  updateStageMetadata(_firmContext, _stageId, _patch) {
    throwRepositoryScaffoldError('PipelineStagesRepository', 'updateStageMetadata')
  }
  deactivateStage(_firmContext, _stageId) {
    throwRepositoryScaffoldError('PipelineStagesRepository', 'deactivateStage')
  }
  reorderStages(_firmContext, _input) {
    throwRepositoryScaffoldError('PipelineStagesRepository', 'reorderStages')
  }
}
