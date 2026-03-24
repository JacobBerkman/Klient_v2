export function createPipelineService({ store }) {
  return {
    moveProfileStage(user, profileId, stage, beforeProfileId = null) {
      return store.moveProfileStage(user, profileId, stage, beforeProfileId);
    },
    getBoard(user) { return store.getBoard(user); }
  };
}
