import { createFirmContext } from '../shared/tenancy.mjs'

export function createPipelineService({ store, policy }) {
  return {
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      policy.requireGuard(user, 'canMovePipeline')
      return store.moveProfileStage(createFirmContext(user), profileId, stage, beforeProfileId)
    },
    getBoard(user) {
      policy.requireGuard(user, 'canReadPipeline')
      return store.getBoard(createFirmContext(user))
    }
  }
}
