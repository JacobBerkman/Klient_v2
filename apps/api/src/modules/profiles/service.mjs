export function createProfilesService({ profileRepository }) {
  return {
    getDashboard(user) { return profileRepository.getDashboard(user); },
    listProfiles(user, query) { return profileRepository.listProfiles(user, query); },
    getProfileDetail(user, profileId) { return profileRepository.getProfileDetail(user, profileId); },
    createProfile(user, input) { return profileRepository.createProfile(user, input); },
    updateProfile(user, profileId, patch) { return profileRepository.updateProfile(user, profileId, patch); },
    listStageHistory(user, profileId) { return profileRepository.listStageHistory(user, profileId); },
    listNotes(user, profileId) { return profileRepository.listNotes(user, profileId); },
    addNote(user, profileId, body) { return profileRepository.addNote(user, profileId, body); },
    getMaskedSensitiveData(user, profileId) { return profileRepository.getMaskedSensitiveData(user, profileId); }
  };
}
