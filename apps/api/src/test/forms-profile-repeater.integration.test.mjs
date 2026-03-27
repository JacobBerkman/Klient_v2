import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createStore } from '../store.mjs'
import { createModules } from '../modules/index.mjs'
import { createHttpServer } from '../server.mjs'

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function jsonRequest(baseUrl, path, { token = '', method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-klient-auth-mode': 'bearer',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload = await response.json()
  return { response, payload }
}

test('profile form flow edits repeater items via targeted endpoints and records audit trail', async () => {
  const store = createStore()
  const reads = {
    listProfiles: () => [],
    getProfileDetail: () => null,
    readMaterializedSummary: () => null
  }
  const modules = createModules({ store, reads })
  const server = createHttpServer({ modules })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    const register = await jsonRequest(baseUrl, '/api/register', {
      method: 'POST',
      body: {
        firmName: 'Integration QA Firm',
        firstName: 'Admin',
        lastName: 'User',
        email: `admin+forms-${randomUUID()}@qa.test`,
        password: 'ChangeMe123!'
      }
    })
    assert.equal(register.response.status, 201)
    const token = register.payload.token

    const createdProfile = await jsonRequest(baseUrl, '/api/profiles', {
      token,
      method: 'POST',
      body: {
        kind: 'client',
        firstName: 'Casey',
        lastName: 'Client',
        email: 'casey.client@qa.test'
      }
    })
    assert.equal(createdProfile.response.status, 201)

    const createdSubmission = await jsonRequest(baseUrl, '/api/forms/submissions', {
      token,
      method: 'POST',
      body: {
        clientId: createdProfile.payload.id,
        templateId: 'intake-form',
        status: 'draft',
        data: {
          householdMembers: [
            { id: 'member-1', fullName: 'Pat Primary', relation: 'self' },
            { id: 'member-2', fullName: 'Sam Secondary', relation: 'spouse' }
          ]
        }
      }
    })
    assert.equal(createdSubmission.response.status, 201)

    const updateItem = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-2`,
      {
        token,
        method: 'PATCH',
        body: { fullName: 'Sam Secondary Updated' }
      }
    )
    assert.equal(updateItem.response.status, 200)

    const deleteItem = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-1`,
      {
        token,
        method: 'DELETE'
      }
    )
    assert.equal(deleteItem.response.status, 200)

    const identityPatch = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-2`,
      {
        token,
        method: 'PATCH',
        body: { id: 'member-3' }
      }
    )
    assert.equal(identityPatch.response.status, 400)
    assert.match(identityPatch.payload.error.message, /identity fields/i)

    const missingItem = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-missing`,
      {
        token,
        method: 'PATCH',
        body: { fullName: 'Ghost Member' }
      }
    )
    assert.equal(missingItem.response.status, 404)
    assert.match(missingItem.payload.error.message, /not found/i)

    const staleUpdate = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-1`,
      {
        token,
        method: 'PATCH',
        body: { relation: 'parent' }
      }
    )
    assert.equal(staleUpdate.response.status, 404)
    assert.match(staleUpdate.payload.error.message, /not found/i)

    const staleDelete = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-1`,
      {
        token,
        method: 'DELETE'
      }
    )
    assert.equal(staleDelete.response.status, 404)
    assert.match(staleDelete.payload.error.message, /not found/i)

    const malformedPatchArray = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-2`,
      {
        token,
        method: 'PATCH',
        body: ['invalid']
      }
    )
    assert.equal(malformedPatchArray.response.status, 400)
    assert.match(malformedPatchArray.payload.error.message, /patch/i)

    const malformedPatchEmpty = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/member-2`,
      {
        token,
        method: 'PATCH',
        body: {}
      }
    )
    assert.equal(malformedPatchEmpty.response.status, 400)
    assert.match(malformedPatchEmpty.payload.error.message, /invalid/i)
    assert.ok(Array.isArray(malformedPatchEmpty.payload.error.details?.issues))

    const invalidSectionSelector = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/%20%20/items/member-2`,
      {
        token,
        method: 'PATCH',
        body: { relation: 'spouse' }
      }
    )
    assert.equal(invalidSectionSelector.response.status, 400)
    assert.match(invalidSectionSelector.payload.error.message, /section key is required/i)

    const invalidItemSelector = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${createdSubmission.payload.id}/sections/householdMembers/items/%20%20`,
      {
        token,
        method: 'PATCH',
        body: { relation: 'spouse' }
      }
    )
    assert.equal(invalidItemSelector.response.status, 400)
    assert.match(invalidItemSelector.payload.error.message, /item key is required/i)

    const submissions = await jsonRequest(baseUrl, '/api/forms/submissions', { token })
    assert.equal(submissions.response.status, 200)
    const persisted = submissions.payload.find((entry) => entry.id === createdSubmission.payload.id)
    assert.ok(persisted)
    assert.deepEqual(persisted.data.householdMembers, [
      { id: 'member-2', fullName: 'Sam Secondary Updated', relation: 'spouse' }
    ])

    const auditEvents = await jsonRequest(baseUrl, '/api/audit', { token })
    assert.equal(auditEvents.response.status, 200)
    assert.ok(Array.isArray(auditEvents.payload), 'Expected audit endpoint to return an array payload.')
  } finally {
    await close(server)
  }
})

test('draft conflict guard enforces lease recovery + revision checks and repeater stale preconditions', async () => {
  const store = createStore()
  const reads = {
    listProfiles: () => [],
    getProfileDetail: () => null,
    readMaterializedSummary: () => null
  }
  const modules = createModules({ store, reads })
  const server = createHttpServer({ modules })
  const address = await listen(server)
  const baseUrl = `http://${address.address}:${address.port}`

  try {
    const register = await jsonRequest(baseUrl, '/api/register', {
      method: 'POST',
      body: {
        firmName: 'Conflict QA Firm',
        firstName: 'Admin',
        lastName: 'User',
        email: `admin+draft-conflict-${randomUUID()}@qa.test`,
        password: 'ChangeMe123!'
      }
    })
    assert.equal(register.response.status, 201)
    const token = register.payload.token

    const createdProfile = await jsonRequest(baseUrl, '/api/profiles', {
      token,
      method: 'POST',
      body: {
        kind: 'client',
        firstName: 'Robin',
        lastName: 'Racer',
        email: 'robin.racer@qa.test'
      }
    })
    assert.equal(createdProfile.response.status, 201)

    const createdSubmission = await jsonRequest(baseUrl, '/api/forms/submissions', {
      token,
      method: 'POST',
      body: {
        clientId: createdProfile.payload.id,
        templateId: 'intake-form',
        status: 'draft',
        data: {
          householdMembers: [{ id: 'member-1', fullName: 'Initial Name', relation: 'self' }]
        }
      }
    })
    assert.equal(createdSubmission.response.status, 201)
    const draftId = createdSubmission.payload.id

    const firstLock = await jsonRequest(baseUrl, `/api/forms/drafts/${draftId}/lock`, {
      token,
      method: 'POST',
      body: { leaseMs: 30_000 }
    })
    assert.equal(firstLock.response.status, 200)
    assert.equal(firstLock.payload.ok, true)
    const originalLeaseId = firstLock.payload.lock.leaseId

    const forcedExpired = await jsonRequest(baseUrl, `/api/forms/submissions/${draftId}`, {
      token,
      method: 'PATCH',
      body: { lock: { ...firstLock.payload.lock, expiresAt: '2000-01-01T00:00:00.000Z' } }
    })
    assert.equal(forcedExpired.response.status, 200)

    const expiredLeaseSave = await jsonRequest(baseUrl, `/api/forms/drafts/${draftId}`, {
      token,
      method: 'PATCH',
      body: {
        leaseId: originalLeaseId,
        expectedRevisionId: 1,
        data: { householdMembers: [{ id: 'member-1', fullName: 'Lease Expired', relation: 'self' }] }
      }
    })
    assert.equal(expiredLeaseSave.response.status, 409)
    assert.equal(expiredLeaseSave.payload.error.code, 'FORMS_DRAFT_REVISE_CONFLICT')
    assert.equal(expiredLeaseSave.payload.error.details?.type, 'lease_conflict')
    assert.equal(expiredLeaseSave.payload.error.details?.suggestedAction, 'refresh_then_reacquire_lock')

    const secondLock = await jsonRequest(baseUrl, `/api/forms/drafts/${draftId}/lock`, {
      token,
      method: 'POST',
      body: { leaseMs: 30_000 }
    })
    assert.equal(secondLock.response.status, 200)
    assert.equal(secondLock.payload.ok, true)

    const firstSave = await jsonRequest(baseUrl, `/api/forms/drafts/${draftId}`, {
      token,
      method: 'PATCH',
      body: {
        leaseId: secondLock.payload.lock.leaseId,
        expectedRevisionId: secondLock.payload.revisionId,
        data: { householdMembers: [{ id: 'member-1', fullName: 'First Save', relation: 'self' }] }
      }
    })
    assert.equal(firstSave.response.status, 200)
    assert.equal(firstSave.payload.ok, true)
    assert.equal(firstSave.payload.submission.revisionId, 2)

    const staleRevisionSave = await jsonRequest(baseUrl, `/api/forms/drafts/${draftId}`, {
      token,
      method: 'PATCH',
      body: {
        leaseId: firstSave.payload.submission.lock.leaseId,
        expectedRevisionId: 1,
        data: { householdMembers: [{ id: 'member-1', fullName: 'Stale Save', relation: 'self' }] }
      }
    })
    assert.equal(staleRevisionSave.response.status, 409)
    assert.equal(staleRevisionSave.payload.error.details?.type, 'revision_conflict')
    assert.equal(staleRevisionSave.payload.error.details?.suggestedAction, 'refresh_then_merge_changes')
    assert.equal(staleRevisionSave.payload.error.details?.serverRevisionId, 2)

    const submissions = await jsonRequest(baseUrl, '/api/forms/submissions', { token })
    assert.equal(submissions.response.status, 200)
    const latest = submissions.payload.find((entry) => entry.id === draftId)
    assert.ok(latest?.updatedAt)

    const repeaterUpdate = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${draftId}/sections/householdMembers/items/member-1`,
      {
        token,
        method: 'PATCH',
        body: { fullName: 'Fresh Update', expectedUpdatedAt: latest.updatedAt }
      }
    )
    assert.equal(repeaterUpdate.response.status, 200)

    const staleRepeaterUpdate = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${draftId}/sections/householdMembers/items/member-1`,
      {
        token,
        method: 'PATCH',
        body: { relation: 'child', expectedUpdatedAt: latest.updatedAt }
      }
    )
    assert.equal(staleRepeaterUpdate.response.status, 409)
    assert.equal(staleRepeaterUpdate.payload.error.code, 'FORMS_SUBMISSION_STALE')
    assert.equal(staleRepeaterUpdate.payload.error.details?.mergePrompt?.type, 'submission_stale')

    const staleDelete = await jsonRequest(
      baseUrl,
      `/api/forms/submissions/${draftId}/sections/householdMembers/items/member-1?expectedUpdatedAt=${encodeURIComponent(
        latest.updatedAt
      )}`,
      {
        token,
        method: 'DELETE'
      }
    )
    assert.equal(staleDelete.response.status, 409)
    assert.equal(staleDelete.payload.error.code, 'FORMS_SUBMISSION_STALE')
  } finally {
    await close(server)
  }
})
