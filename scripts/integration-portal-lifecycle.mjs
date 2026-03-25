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
    body: JSON.stringify({ profileId: profile.id })
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
  const sectionState = await context.request(`/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 0, data: { fields: { primaryGoal: 'Financial independence' } } })
  })
  assert(sectionState.ok === true, 'Initial draft section write failed.')

  const refreshedSectionState = await context.request(
    `/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`
  )
  assert(refreshedSectionState.version === 1, 'Draft section state did not survive refresh.')

  const tabAWrite = await context.request(`/api/portal/${portalLink.token}/drafts/${savedDraft.id}/sections/${sectionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, data: { fields: { primaryGoal: 'Tab A update' } } })
  })
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

  await context.request(`/api/portal/${portalLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Retire in 10 years' }
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

  console.log(
    JSON.stringify(
      {
        suite: 'integration-portal-lifecycle',
        portalLinkId: portalLink.id,
        submissionCount: refreshedPortal.submissions.length,
        draftSectionVersion: staleTabConflict.state.version
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
