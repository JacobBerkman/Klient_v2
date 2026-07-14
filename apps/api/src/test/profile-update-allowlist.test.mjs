import test from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../store.mjs'

function adminOf(store) {
  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  return store.requireUser(session.token)
}

function createClient(store, admin, suffix) {
  return store.createProfile(admin, {
    kind: 'client',
    firstName: 'Allow',
    lastName: 'List',
    email: `allowlist.${suffix}@demo.test`,
    ssn: '123-45-6789'
  })
}

test('updateProfile ignores firmId in the patch (no cross-tenant move)', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'firm')
  const originalFirmId = profile.firmId

  const updated = store.updateProfile(admin, profile.id, {
    firstName: 'Renamed',
    firmId: 'attacker-firm'
  })

  assert.equal(updated.firstName, 'Renamed', 'legitimate field still applies')
  assert.equal(updated.firmId, originalFirmId, 'firmId is not reassignable from a request body')

  const detail = store.getProfileDetail(admin, profile.id)
  assert.equal(detail.profile.firmId, originalFirmId, 'persisted row keeps the original firm')
})

test('updateProfile ignores id and createdAt in the patch', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'identity')

  const updated = store.updateProfile(admin, profile.id, {
    id: 'attacker-chosen-id',
    createdAt: '1999-01-01T00:00:00.000Z',
    phone: '555-0100'
  })

  assert.equal(updated.id, profile.id, 'id is immutable')
  assert.equal(updated.createdAt, profile.createdAt, 'createdAt is immutable')
  assert.equal(updated.phone, '555-0100', 'legitimate field still applies')
})

test('updateProfile cannot replace the encrypted pii envelope with plaintext', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'pii')
  const originalPii = JSON.parse(JSON.stringify(profile.pii))

  const updated = store.updateProfile(admin, profile.id, {
    pii: { maskingPolicy: 'none', ssnEncrypted: '000-00-0000' }
  })

  assert.deepEqual(updated.pii, originalPii, 'pii envelope is not writable directly')
  assert.notEqual(updated.pii.ssnEncrypted, '000-00-0000', 'ciphertext was not swapped for plaintext')
})

test('updateProfile encrypts a patched dateOfBirth instead of storing it in the clear', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'dob')

  const updated = store.updateProfile(admin, profile.id, { dateOfBirth: '1980-05-01' })

  assert.equal(updated.dateOfBirth, '', 'plaintext column stays empty, matching createProfile')
  assert.ok(updated.pii?.dobEncrypted, 'DOB is stored in the encrypted envelope')
  assert.notEqual(
    JSON.stringify(updated.pii.dobEncrypted),
    JSON.stringify('1980-05-01'),
    'DOB is not persisted as plaintext'
  )
})
