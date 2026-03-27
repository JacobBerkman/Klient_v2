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
