import test from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../store.mjs'
import { createModules } from '../modules/index.mjs'

function createReads() {
  return {
    listProfiles: () => [],
    getProfileDetail: () => null,
    readMaterializedSummary: () => null
  }
}

function inviteAndAccept(store, admin, { email, role, firstName }) {
  const invite = store.inviteUser(admin, { email, role })
  const accepted = store.acceptInvite({
    token: invite.token,
    firstName,
    lastName: 'Tester',
    password: 'ChangeMe123!'
  })
  return store.requireUser(accepted.token)
}

test('draft collaboration regression enforces role + collaborator boundaries for read/write actions', () => {
  const store = createStore()
  const modules = createModules({ store, reads: createReads() })
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const admin = store.requireUser(adminSession.token)
  const advisor = inviteAndAccept(store, admin, { email: 'advisor-collab@demo.test', role: 'advisor', firstName: 'Adv' })
  const readonly = inviteAndAccept(store, admin, {
    email: 'readonly-collab@demo.test',
    role: 'readonly',
    firstName: 'Read'
  })

  const profile = store.createProfile(admin, {
    kind: 'client',
    firstName: 'Draft',
    lastName: 'Client',
    email: 'draft.client@demo.test'
  })
  const draft = modules.forms.createFormSubmission(admin, {
    clientId: profile.id,
    templateId: 'intake-form',
    status: 'draft',
    data: { householdMembers: [] }
  })
  assert.deepEqual(draft.collaborators, [{ userId: admin.id, permission: 'write' }])

  assert.equal(modules.forms.listFormDrafts(advisor).length, 0)
  assert.equal(modules.forms.listFormDrafts(readonly).length, 0)
  assert.throws(() => modules.forms.acquireDraftLock(advisor, draft.id, {}), /access denied/i)
  assert.throws(() => modules.forms.listDraftCollaborators(readonly, draft.id), /Missing permission: canManageDraftSharing/)

  const addAdvisor = modules.forms.addDraftCollaborator(admin, draft.id, { userId: advisor.id, permission: 'write' })
  assert.equal(addAdvisor.feedback.code, 'DRAFT_COLLABORATOR_ADDED')
  const addReadonly = modules.forms.addDraftCollaborator(admin, draft.id, { userId: readonly.id, permission: 'read' })
  assert.equal(addReadonly.feedback.code, 'DRAFT_COLLABORATOR_ADDED')
  const collaboratorSnapshot = modules.forms.listDraftCollaborators(admin, draft.id)
  assert.equal(collaboratorSnapshot.feedback.code, 'DRAFT_COLLABORATORS_LOADED')
  assert.deepEqual(
    collaboratorSnapshot.collaborators.map((entry) => [entry.userId, entry.permission]),
    [
      [admin.id, 'write'],
      [advisor.id, 'write'],
      [readonly.id, 'read']
    ]
  )
  assert.throws(() => modules.forms.addDraftCollaborator(admin, draft.id, { userId: advisor.id }), (error) => {
    assert.equal(error.code, 'FORMS_DRAFT_COLLABORATORS_ALREADY_ADDED')
    return true
  })
  assert.throws(() => modules.forms.addDraftCollaborator(advisor, draft.id, { userId: advisor.id }), (error) => {
    assert.equal(error.code, 'FORMS_DRAFT_COLLABORATORS_ALREADY_ADDED')
    return true
  })

  assert.equal(modules.forms.listFormDrafts(advisor).length, 1)
  assert.equal(modules.forms.listFormDrafts(readonly).length, 1)
  assert.throws(() => modules.forms.listDraftCollaborators(readonly, draft.id), /Missing permission: canManageDraftSharing/)

  const lock = modules.forms.acquireDraftLock(advisor, draft.id, { leaseMs: 30_000 })
  assert.equal(lock.ok, true)
  const revised = modules.forms.reviseDraftSubmission(advisor, draft.id, {
    leaseId: lock.lock.leaseId,
    expectedRevisionId: lock.revisionId,
    data: { householdMembers: [{ id: 'member-1', fullName: 'Allowed Advisor', relation: 'self' }] }
  })
  assert.equal(revised.ok, true)

  assert.throws(() => modules.forms.acquireDraftLock(readonly, draft.id, {}), /Missing permission: canWriteForms/)
  assert.throws(
    () =>
      modules.forms.reviseDraftSubmission(readonly, draft.id, {
        leaseId: 'nope',
        expectedRevisionId: 2,
        data: {}
      }),
    /Missing permission: canWriteForms/
  )

  assert.throws(() => modules.forms.removeDraftCollaborator(admin, draft.id, admin.id), (error) => {
    assert.equal(error.code, 'FORMS_DRAFT_COLLABORATORS_OWNER_IMMUTABLE')
    return true
  })
  assert.throws(() => modules.forms.removeDraftCollaborator(admin, draft.id, 'missing-user-id'), (error) => {
    assert.equal(error.code, 'FORMS_DRAFT_COLLABORATORS_ALREADY_REMOVED')
    return true
  })
  const afterRemoval = modules.forms.removeDraftCollaborator(admin, draft.id, readonly.id)
  assert.equal(afterRemoval.feedback.code, 'DRAFT_COLLABORATOR_REMOVED')
  assert.ok(afterRemoval.collaborators.every((entry) => entry.userId !== readonly.id))
  assert.equal(modules.forms.listFormDrafts(readonly).length, 0)
  assert.equal(modules.forms.listFormDrafts(advisor).length, 1)
  assert.throws(() => modules.forms.removeDraftCollaborator(admin, draft.id, readonly.id), (error) => {
    assert.equal(error.code, 'FORMS_DRAFT_COLLABORATORS_ALREADY_REMOVED')
    return true
  })

  // audit_events table is the source of truth: read through listAudit.
  const auditActions = store
    .listAudit(admin)
    .filter((entry) => entry.entityType === 'form_submission' && entry.entityId === draft.id)
    .map((entry) => entry.action)
  assert.ok(auditActions.includes('form_submission.collaborator_added'))
  assert.ok(auditActions.includes('form_submission.collaborator_removed'))
})
