import test from 'node:test'
import assert from 'node:assert/strict'

import { StoreProfileRepository } from '../repositories/store-adapters.mjs'

test('store profile repository does not backfill foreign profile detail from workspace/read model', () => {
  const error = new Error('Profile not found.')
  error.statusCode = 404

  let readsCalled = false
  const repository = new StoreProfileRepository(
    {
      getProfileDetail: () => {
        throw error
      }
    },
    {
      getProfileDetail: () => {
        readsCalled = true
        return { id: 'profile-foreign', firmId: 'foreign-firm' }
      }
    }
  )

  assert.throws(
    () => repository.getProfileDetail({ firmId: 'firm-1', role: 'advisor' }, 'profile-foreign'),
    (caught) => caught === error
  )
  assert.equal(readsCalled, false)
})

test('store profile repository forwards tenant context to updateProfile writes', () => {
  let capturedContext = null
  const repository = new StoreProfileRepository(
    {
      updateProfile: (firmContext, profileId, patch) => {
        capturedContext = firmContext
        return { id: profileId, ...patch }
      }
    },
    {}
  )

  const updated = repository.updateProfile(
    { firmId: 'firm-2', role: 'advisor', userId: 'user-2' },
    'profile-2',
    { firstName: 'TenantSafe' }
  )

  assert.equal(capturedContext.firmId, 'firm-2')
  assert.equal(updated.id, 'profile-2')
  assert.equal(updated.firstName, 'TenantSafe')
})
