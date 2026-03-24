export function createPipelineService({ pipelineRepository }) {
  return {
    moveProfileStage(user, profileId, stage, beforeProfileId = null, concurrency = {}) {
      return pipelineRepository.reorderBoard(user, {
        profileId,
        toStage: stage,
        beforeProfileId,
        ...concurrency
      });
    },
    reorderBoard(user, input) {
      return pipelineRepository.reorderBoard(user, input);
    },
    normalizeBoardOrdering(user) {
      return pipelineRepository.normalizeBoardOrdering(user);
    },
    getBoard(user) {
      return pipelineRepository.getBoard(user);
    }
export function createPipelineService({ store, policy }) {
  return {
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      policy.requireGuard(user, 'canMovePipeline');
      return store.moveProfileStage(user, profileId, stage, beforeProfileId);
    },
    getBoard(user) { policy.requireGuard(user, 'canReadPipeline'); return store.getBoard(user); }
  };
}
