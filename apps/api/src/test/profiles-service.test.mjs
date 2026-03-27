import test from 'node:test'
import assert from 'node:assert/strict'

import { createProfilesService } from '../modules/profiles/service.mjs'
import { createPolicy } from '../modules/shared/policy.mjs'

function createServiceWithRepo(overrides = {}) {
  const calls = { updatePatch: null }
  const profileRepository = {
    getProfileDetail: async () => ({ id: 'profile-1', updatedAt: '2026-03-27T08:00:00.000Z' }),
    updateProfile: async (_ctx, _profileId, patch) => {
      calls.updatePatch = patch
      return { id: 'profile-1', ...patch }
    },
    ...overrides
  }
  const service = createProfilesService({ profileRepository, policy: createPolicy() })
  return { service, calls }
}

test('profiles service rejects stale expectedUpdatedAt precondition', async () => {
  const { service, calls } = createServiceWithRepo()
  const user = { id: 'advisor-1', role: 'advisor', firmId: 'firm-1' }

  await assert.rejects(
    service.updateProfile(user, 'profile-1', {
      firstName: 'Jordan',
      expectedUpdatedAt: '2026-03-27T07:59:00.000Z'
    }),
    (error) => {
      assert.equal(error.code, 'PROFILE_UPDATE_CONFLICT')
      assert.equal(error.statusCode, 409)
      assert.equal(error.details.expectedUpdatedAt, '2026-03-27T07:59:00.000Z')
      assert.equal(error.details.currentUpdatedAt, '2026-03-27T08:00:00.000Z')
      return true
    }
  )

  assert.equal(calls.updatePatch, null)
})

test('profiles service strips expectedUpdatedAt before repository update', async () => {
  const { service, calls } = createServiceWithRepo({
    getProfileDetail: async () => ({ id: 'profile-1', updatedAt: '2026-03-27T08:00:00.000Z' })
  })
  const user = { id: 'admin-1', role: 'admin', firmId: 'firm-1' }

  const updated = await service.updateProfile(user, 'profile-1', {
    firstName: 'Morgan',
    expectedUpdatedAt: '2026-03-27T08:00:00.000Z'
  })

  assert.equal(updated.expectedUpdatedAt, undefined)
  assert.deepEqual(calls.updatePatch, { firstName: 'Morgan' })
})
