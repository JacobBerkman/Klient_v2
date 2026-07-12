import { createFirmContext } from '../shared/tenancy.mjs'

function customFieldGroupName(field = {}) {
  const rawGroup = field?.metadata && typeof field.metadata === 'object' ? field.metadata.group : ''
  return String(rawGroup || 'General').trim() || 'General'
}

function customFieldSortOrder(field = {}) {
  const rawOrder = field?.metadata && typeof field.metadata === 'object' ? field.metadata.order : null
  if (rawOrder == null || rawOrder === '') return Number.POSITIVE_INFINITY
  const parsed = Number(rawOrder)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function sortCustomFields(fields = []) {
  return [...fields].sort((a, b) => {
    const groupCompare = customFieldGroupName(a).localeCompare(customFieldGroupName(b))
    if (groupCompare !== 0) return groupCompare
    const orderCompare = customFieldSortOrder(a) - customFieldSortOrder(b)
    if (orderCompare !== 0) return orderCompare
    const labelCompare = String(a?.label || a?.key || '').localeCompare(String(b?.label || b?.key || ''))
    if (labelCompare !== 0) return labelCompare
    return String(a?.key || '').localeCompare(String(b?.key || ''))
  })
}

function withSortedSchema(result = {}) {
  if (!result || typeof result !== 'object') return result
  if (!Array.isArray(result.fields)) return result
  return { ...result, fields: sortCustomFields(result.fields) }
}

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
    async convertProfile(user, profileId, input = {}) {
      policy.requireGuard(user, 'canWriteProfiles')
      const expectedUpdatedAt =
        typeof input?.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt.trim() : input?.expectedUpdatedAt
      // Reuse the shared optimistic-concurrency precondition so a stale
      // expectedUpdatedAt fails with the same PROFILE_UPDATE_CONFLICT (409)
      // contract as updateProfile before the board-touching write begins. The
      // store re-checks inside its transaction to close the read/convert race.
      await assertUpdatePreconditions(user, profileId, { expectedUpdatedAt })
      return profileRepository.convertProfile(createFirmContext(user), profileId, { expectedUpdatedAt })
    },
    async archiveProfile(user, profileId, input = {}) {
      policy.requireGuard(user, 'canWriteProfiles')
      const expectedUpdatedAt =
        typeof input?.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt.trim() : input?.expectedUpdatedAt
      // Same optimistic-concurrency contract as convert: a stale expectedUpdatedAt
      // fails with PROFILE_UPDATE_CONFLICT before the store write; the store
      // re-checks inside its transaction to close the read/archive race.
      await assertUpdatePreconditions(user, profileId, { expectedUpdatedAt })
      return profileRepository.archiveProfile(createFirmContext(user), profileId, { expectedUpdatedAt })
    },
    async restoreProfile(user, profileId, input = {}) {
      policy.requireGuard(user, 'canWriteProfiles')
      const expectedUpdatedAt =
        typeof input?.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt.trim() : input?.expectedUpdatedAt
      await assertUpdatePreconditions(user, profileId, { expectedUpdatedAt })
      return profileRepository.restoreProfile(createFirmContext(user), profileId, { expectedUpdatedAt })
    },
    addTag(user, profileId, tag) {
      policy.requireGuard(user, 'canWriteProfiles')
      return profileRepository.addTag(createFirmContext(user), profileId, tag)
    },
    removeTag(user, profileId, tag) {
      policy.requireGuard(user, 'canWriteProfiles')
      return profileRepository.removeTag(createFirmContext(user), profileId, tag)
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
      return withSortedSchema(profileRepository.getCustomFieldSchema(createFirmContext(user)))
    },
    createCustomField(user, input) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.createCustomField(createFirmContext(user), input)
    },
    updateCustomField(user, fieldKey, patch) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.updateCustomField(createFirmContext(user), fieldKey, patch)
    },
    dryRunCustomFieldSchema(user, input) {
      policy.requireGuard(user, 'canManageUsers')
      const preview = profileRepository.dryRunCustomFieldSchema(createFirmContext(user), input)
      if (preview?.diff) {
        return {
          ...preview,
          normalizedRows: sortCustomFields(preview.normalizedRows || []),
          diff: {
            ...preview.diff,
            added: sortCustomFields(preview.diff.added || []),
            unchanged: sortCustomFields(preview.diff.unchanged || []),
            removed: sortCustomFields(preview.diff.removed || []),
            updated: [...(preview.diff.updated || [])].sort((a, b) =>
              String(a?.after?.key || a?.before?.key || '').localeCompare(String(b?.after?.key || b?.before?.key || ''))
            )
          }
        }
      }
      return preview
    },
    deleteCustomField(user, fieldKey) {
      policy.requireGuard(user, 'canManageUsers')
      return profileRepository.deleteCustomField(createFirmContext(user), fieldKey)
    }
  }
}
