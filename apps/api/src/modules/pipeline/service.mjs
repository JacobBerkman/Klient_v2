export function createPipelineService({ store, policy }) {
  return {
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      policy.requireGuard(user, 'canMovePipeline')
      return store.moveProfileStage(user, profileId, stage, beforeProfileId)
    },
    reorderBoard(user, input) {
      policy.requireGuard(user, 'canMovePipeline')
      return store.reorderBoard(user, input)
    },
    getBoard(user) {
      policy.requireGuard(user, 'canReadPipeline')
      return store.getBoard(user)
    }
  }
}
