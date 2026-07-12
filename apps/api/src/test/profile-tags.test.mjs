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
    firstName: 'Tag',
    lastName: 'Client',
    email: `tag.client.${suffix}@demo.test`
  })
}

test('addProfileTag normalizes, dedupes case-insensitively, and audits', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'add')

  store.addProfileTag(admin, profile.id, '  VIP  ')
  store.addProfileTag(admin, profile.id, 'high-net-worth')
  // Duplicate (different case + surrounding whitespace) must not be added twice.
  const afterDup = store.addProfileTag(admin, profile.id, 'vip')
  assert.deepEqual(afterDup.tags, ['VIP', 'high-net-worth'])

  const detail = store.getProfileDetail(admin, profile.id)
  assert.deepEqual(detail.profile.tags, ['VIP', 'high-net-worth'])

  const audits = store.listAudit(admin).filter((event) => event.action === 'profile.tag_added')
  assert.ok(audits.length >= 2, 'tag additions emit audit events')
})

test('removeProfileTag removes case-insensitively and is a no-op when absent', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'remove')

  store.addProfileTag(admin, profile.id, 'Retirement')
  store.addProfileTag(admin, profile.id, 'Referral')

  const afterRemove = store.removeProfileTag(admin, profile.id, 'retirement')
  assert.deepEqual(afterRemove.tags, ['Referral'])

  // Removing a tag that is not present leaves the list unchanged.
  const noop = store.removeProfileTag(admin, profile.id, 'does-not-exist')
  assert.deepEqual(noop.tags, ['Referral'])

  const removedAudit = store.listAudit(admin).filter((event) => event.action === 'profile.tag_removed')
  assert.ok(removedAudit.length >= 1, 'tag removal emits an audit event')
})

test('updateProfile normalizes a tags array (trim, dedupe, cap length/count)', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'update')

  const longTag = 'x'.repeat(60)
  const many = Array.from({ length: 30 }, (_, index) => `tag-${index}`)
  const updated = store.updateProfile(admin, profile.id, {
    tags: ['  Alpha ', 'alpha', '', longTag, ...many]
  })

  // Dedupe folds "Alpha"/"alpha"; the long tag is capped to 40 chars; the total
  // is capped at 20 entries.
  assert.equal(updated.tags.length, 20)
  assert.equal(updated.tags[0], 'Alpha')
  assert.ok(updated.tags.every((tag) => tag.length <= 40))
  assert.equal(new Set(updated.tags.map((tag) => tag.toLowerCase())).size, updated.tags.length)
})

test('tags are firm-scoped: a cross-tenant profile id is rejected', () => {
  const store = createStore()
  const admin = adminOf(store)
  const profile = createClient(store, admin, 'scope')

  const foreignUser = { id: 'intruder', firmId: 'some-other-firm', role: 'admin' }
  assert.throws(() => store.addProfileTag(foreignUser, profile.id, 'leak'))
})
