import { createFirmContext } from '../shared/tenancy.mjs'

export function createProfilesService({ profileRepository, policy }) {
  async function assertUpdatePreconditions(user, profileId, patch) {
    if (!patch || typeof patch !== 'object') return patch
    const expectedUpdatedAt =
      typeof patch.expectedUpdatedAt === 'string' ? patch.expectedUpdatedAt.trim() : patch.expectedUpdatedAt
    if (!expectedUpdatedAt) return patch
    const latest = await profileRepository.getProfileDetail(createFirmContext(user), profileId)
    const currentUpdatedAt = latest?.updatedAt || latest?.profile?.updatedAt || null
    if (currentUpdatedAt && String(currentUpdatedAt) !== String(expectedUpdatedAt)) {
      const error = new Error('Profile update conflict: updatedAt precondition failed.')
      error.statusCode = 409
      error.code = 'PROFILE_UPDATE_CONFLICT'
      error.details = {
        expectedUpdatedAt,
        currentUpdatedAt,
        mergePrompt: {
          suggestion: 'Conflict detected: another change was saved first. Review latest data and retry.'
        }
      }
      throw error
    }
    const { expectedUpdatedAt: _ignoredExpectedUpdatedAt, ...nextPatch } = patch
    return nextPatch
  }

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
    async updateProfile(user, profileId, patch) {
      policy.requireGuard(user, 'canWriteProfiles')
      const patchWithPreconditions = await assertUpdatePreconditions(user, profileId, patch)
      return profileRepository.updateProfile(createFirmContext(user), profileId, patchWithPreconditions)
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
    },
    getCustomFieldSchema(user) {
      policy.requireGuard(user, 'canReadProfiles')
      return profileRepository.getCustomFieldSchema(createFirmContext(user))
    },
    createCustomField(user, input) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.createCustomField(createFirmContext(user), input)
    },
    updateCustomField(user, fieldKey, patch) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.updateCustomField(createFirmContext(user), fieldKey, patch)
    },
    deleteCustomField(user, fieldKey) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.deleteCustomField(createFirmContext(user), fieldKey)
    }
  }
}
