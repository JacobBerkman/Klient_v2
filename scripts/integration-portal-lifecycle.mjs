import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('portal-lifecycle')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Portal',
      lastName: 'Client',
      email: `portal.client+${Date.now()}@example.com`
    })
  })

  const formTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Discovery Form',
      sections: [{ title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] }]
    })
  })

  const portalLink = await context.request('/api/portal-links', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      profileId: profile.id,
      expiresInHours: 2,
      maxUses: 4,
      templateIds: [formTemplate.id],
      uploadCategories: ['tax']
    })
  })

  const initialPortal = await context.request(`/api/portal/${portalLink.token}`)
  await context.request(`/api/portal/${portalLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'draft',
      data: { primaryGoal: 'Financial independence' }
    })
  })
  const refreshedAfterDraft = await context.request(`/api/portal/${portalLink.token}`)
  const savedDraft = refreshedAfterDraft.submissions.find(
    (entry) => entry.templateId === formTemplate.id && entry.status === 'draft'
  )
  assert(savedDraft, 'Portal draft was not persisted.')

  const sectionId = 'goals'
  try {
    const sectionState = await context.request(
      `/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 0, data: { fields: { primaryGoal: 'Financial independence' } } })
      }
    )
    assert(sectionState.ok === true, 'Initial draft section write failed.')

    const refreshedSectionState = await context.request(
      `/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`
    )
    assert(refreshedSectionState.version === 1, 'Draft section state did not survive refresh.')

    const tabAWrite = await context.request(
      `/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1, data: { fields: { primaryGoal: 'Tab A update' } } })
      }
    )
    assert(tabAWrite.ok === true && tabAWrite.state.version === 2, 'Tab A optimistic write failed.')

    const staleTabConflict = await context.requestExpectError(
      `/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1, data: { fields: { primaryGoal: 'Tab B stale write' } } })
      },
      409
    )
    assert(staleTabConflict.conflict === true, 'Expected stale cross-tab conflict response.')
    assert(staleTabConflict.state?.version === 2, 'Conflict response should include latest server version.')
  } catch (error) {
    if (!/Not found/i.test(error.message)) throw error
  }

  await context.request(`/api/portal/${portalLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Retire in 10 years' }
    })
  })
  const uploadPresign = await context.request(`/api/portal/${portalLink.token}/uploads/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: 'portal-tax-doc.pdf',
      contentType: 'application/pdf',
      category: 'tax',
      retentionClass: 'uploaded_document'
    })
  })
  await context.request(`/api/portal/${portalLink.token}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: uploadPresign.uploadId,
      name: 'Portal Tax Package',
      category: 'tax',
      object: uploadPresign.object,
      malwareScan: { status: 'pending', provider: 'integration-test' }
    })
  })
  const refreshedPortal = await context.request(`/api/portal/${portalLink.token}`)

  assert(
    initialPortal.availableTemplates.some((entry) => entry.id === formTemplate.id),
    'Portal template not exposed'
  )
  assert(
    refreshedPortal.submissions.some((entry) => entry.status === 'draft'),
    'Portal draft missing'
  )
  assert(
    refreshedPortal.submissions.some((entry) => entry.status === 'submitted'),
    'Portal submitted record missing'
  )
  assert(refreshedPortal.uploads.some((entry) => entry.name === 'Portal Tax Package'), 'Portal upload missing')

  await context.request(`/api/portal-links/${portalLink.id}/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  })
  await context.requestExpectError(`/api/portal/${portalLink.token}`, {}, 400)
  await context.requestExpectError(
    `/api/portal/${portalLink.token}/submissions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: formTemplate.id,
        status: 'submitted',
        data: { primaryGoal: 'Blocked by revoke' }
      })
    },
    400
  )

  const singleUseLink = await context.request('/api/portal-links', {
    method: 'POST',
    headers,
    body: JSON.stringify({ profileId: profile.id, maxUses: 1, templateIds: [formTemplate.id] })
  })
  await context.request(`/api/portal/${singleUseLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Single-use submission' }
    })
  })
  await context.requestExpectError(`/api/portal/${singleUseLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Attempt reuse' }
    })
  })

  console.log(
    JSON.stringify(
      {
        suite: 'integration-portal-lifecycle',
        portalLinkId: portalLink.id,
        submissionCount: refreshedPortal.submissions.length,
        uploadCount: refreshedPortal.uploads.length
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
