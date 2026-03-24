export function createProfilesService({ profileRepository, policy }) {
  return {
    getDashboard(user) { policy.requireGuard(user, 'canViewDashboard'); return profileRepository.getDashboard(user); },
    listProfiles(user, query) { policy.requireGuard(user, 'canReadProfiles'); return profileRepository.listProfiles(user, query); },
    getProfileDetail(user, profileId) { policy.requireGuard(user, 'canReadProfiles'); return profileRepository.getProfileDetail(user, profileId); },
    createProfile(user, input) { policy.requireGuard(user, 'canWriteProfiles'); return profileRepository.createProfile(user, input); },
    updateProfile(user, profileId, patch) { policy.requireGuard(user, 'canWriteProfiles'); return profileRepository.updateProfile(user, profileId, patch); },
    listStageHistory(user, profileId) { policy.requireGuard(user, 'canReadProfiles'); return profileRepository.listStageHistory(user, profileId); },
    listNotes(user, profileId) { policy.requireGuard(user, 'canReadProfiles'); return profileRepository.listNotes(user, profileId); },
    addNote(user, profileId, body) { policy.requireGuard(user, 'canWriteProfiles'); return profileRepository.addNote(user, profileId, body); },
    getMaskedSensitiveData(user, profileId) { policy.requireGuard(user, 'canReadSensitiveProfileData'); return profileRepository.getMaskedSensitiveData(user, profileId); }
  };
}
