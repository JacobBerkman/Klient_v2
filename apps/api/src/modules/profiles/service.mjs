import { createFirmContext } from '../shared/tenancy.mjs'

export function createProfilesService({ profileRepository, policy }) {
  return {
    getDashboard(user) {
      policy.requireGuard(user, 'canViewDashboard')
      return profileRepository.getDashboard(createFirmContext(user))
    },
    listProfiles(user, query) {
      policy.requireGuard(user, 'canReadProfiles')
      return profileRepository.listProfiles(createFirmContext(user), query)
    },
    getProfileDetail(user, profileId) {
      policy.requireGuard(user, 'canReadProfiles')
      return profileRepository.getProfileDetail(createFirmContext(user), profileId)
    },
    createProfile(user, input) {
      policy.requireGuard(user, 'canWriteProfiles')
      return profileRepository.createProfile(createFirmContext(user), input)
    },
    updateProfile(user, profileId, patch) {
      policy.requireGuard(user, 'canWriteProfiles')
      return profileRepository.updateProfile(createFirmContext(user), profileId, patch)
    },
    listStageHistory(user, profileId) {
      policy.requireGuard(user, 'canReadProfiles')
      return profileRepository.listStageHistory(createFirmContext(user), profileId)
    },
    listNotes(user, profileId) {
      policy.requireGuard(user, 'canReadProfiles')
      return profileRepository.listNotes(createFirmContext(user), profileId)
    },
    addNote(user, profileId, body) {
      policy.requireGuard(user, 'canWriteProfiles')
      return profileRepository.addNote(createFirmContext(user), profileId, body)
    },
    getMaskedSensitiveData(user, profileId) {
      policy.requireGuard(user, 'canReadSensitiveProfileData')
      return profileRepository.getMaskedSensitiveData(createFirmContext(user), profileId)
    }
  }
}
