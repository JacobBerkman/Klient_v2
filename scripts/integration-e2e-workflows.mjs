import { createEvidenceRecorder } from './release-evidence.mjs'
import { assert, createTestContext } from './test-harness.mjs'

const evidence = createEvidenceRecorder({
  gate: 'e2e',
  defaultFile: 'e2e-workflows.json',
  envVarName: 'RELEASE_EVIDENCE_E2E_FILE',
  command: 'node scripts/integration-e2e-workflows.mjs'
})

const context = await createTestContext('e2e-workflows')

try {
  const registration = await context.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firmName: 'E2E Deterministic Firm',
      firstName: 'Bootstrap',
      lastName: 'Admin',
      email: 'bootstrap.admin@e2e.test',
      password: 'StrongPass123!'
    })
  })
  assert(registration.user?.role === 'admin', 'Admin bootstrap registration should create an admin user.')

  const adminLogin = await context.login('bootstrap.admin@e2e.test', 'StrongPass123!', 'admin')
  assert(adminLogin.user?.role === 'admin', 'Admin login should return an admin role.')
  const adminHeaders = context.authHeaders('admin')

  const advisorInvite = await context.requestAs('admin', '/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: 'advisor.user@e2e.test', role: 'advisor' })
  })
  const advisorAccepted = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: advisorInvite.token,
      firstName: 'Advisor',
      lastName: 'User',
      password: 'AdvisorPass123!'
    })
  })
  await context.login(advisorAccepted.user.email, 'AdvisorPass123!', 'advisor')
  const advisorHeaders = context.authHeaders('advisor')

  await context.requestAs('admin', '/api/profiles/custom-fields/schema', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      key: 'client_note',
      type: 'text',
      label: 'Client Note',
      required: false
    })
  })
  await context.requestAs('admin', '/api/profiles/custom-fields/schema', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      key: 'estimated_assets',
      type: 'number',
      label: 'Estimated Assets',
      required: false
    })
  })
  await context.requestAs('admin', '/api/profiles/custom-fields/schema', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      key: 'onboard_date',
      type: 'date',
      label: 'Onboard Date',
      required: false
    })
  })
  await context.requestAs('admin', '/api/profiles/custom-fields/schema', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      key: 'vip_client',
      type: 'boolean',
      label: 'VIP Client',
      required: false
    })
  })
  const schemaSnapshot = await context.requestAs('advisor', '/api/profiles/custom-fields/schema', { headers: advisorHeaders })
  const createdKeys = new Set((schemaSnapshot.fields || []).map((field) => field.key))
  assert(createdKeys.has('client_note'), 'Text custom field should be created.')
  assert(createdKeys.has('estimated_assets'), 'Number custom field should be created.')
  assert(createdKeys.has('onboard_date'), 'Date custom field should be created.')
  assert(createdKeys.has('vip_client'), 'Boolean custom field should be created.')

  const profile = await context.requestAs('advisor', '/api/profiles', {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({
      kind: 'client',
      firstName: 'Taylor',
      lastName: 'Client',
      email: 'taylor.client@e2e.test',
      extensions: {
        schemaVersion: '1.0.0',
        values: {
          client_note: 'Prefers quarterly reviews',
          estimated_assets: 725000,
          onboard_date: '2026-04-13',
          vip_client: true
        }
      }
    })
  })
  assert(profile.extensions?.values?.client_note === 'Prefers quarterly reviews', 'Text custom field should persist.')
  assert(profile.extensions?.values?.estimated_assets === 725000, 'Number custom field should persist.')
  assert(profile.extensions?.values?.onboard_date === '2026-04-13', 'Date custom field should persist.')
  assert(profile.extensions?.values?.vip_client === true, 'Boolean custom field should persist.')

  const profileDetail = await context.requestAs('advisor', `/api/profiles/${profile.id}`, { headers: advisorHeaders })
  assert(profileDetail.profile?.extensions?.values?.client_note === profile.extensions?.values?.client_note, 'Profile detail should preserve custom field text parity.')
  assert(
    profileDetail.profile?.extensions?.values?.estimated_assets === profile.extensions?.values?.estimated_assets,
    'Profile detail should preserve custom field number parity.'
  )
  assert(profileDetail.profile?.extensions?.values?.onboard_date === profile.extensions?.values?.onboard_date, 'Profile detail should preserve custom field date parity.')
  assert(profileDetail.profile?.extensions?.values?.vip_client === profile.extensions?.values?.vip_client, 'Profile detail should preserve custom field boolean parity.')

  const formTemplate = await context.requestAs('advisor', '/api/forms/templates', {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({
      name: 'Advisor Intake Workflow',
      sections: [
        {
          title: 'Goals',
          fields: [
            { key: 'primaryGoal', label: 'Primary Goal', type: 'text', required: true },
            { key: 'riskTolerance', label: 'Risk Tolerance', type: 'text' }
          ]
        }
      ]
    })
  })

  const draft = await context.requestAs('advisor', '/api/forms/submissions', {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'draft',
      data: { primaryGoal: 'Save more aggressively', riskTolerance: 'Balanced' }
    })
  })

  const firstLock = await context.requestAs('advisor', `/api/forms/drafts/${draft.id}/lock`, {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({ leaseMs: 30_000 })
  })
  assert(firstLock.ok === true, 'Advisor should acquire draft lock.')

  await context.requestAs('advisor', `/api/forms/submissions/${draft.id}`, {
    method: 'PATCH',
    headers: advisorHeaders,
    body: JSON.stringify({ lock: { ...firstLock.lock, expiresAt: '2000-01-01T00:00:00.000Z' } })
  })

  const leaseConflict = await context.requestExpectErrorAs(
    'advisor',
    `/api/forms/drafts/${draft.id}`,
    {
      method: 'PATCH',
      headers: advisorHeaders,
      body: JSON.stringify({
        leaseId: firstLock.lock.leaseId,
        expectedRevisionId: draft.revisionId || 1,
        data: { primaryGoal: 'Should fail due to expired lease' }
      })
    },
    409
  )
  assert(leaseConflict.error?.details?.type === 'lease_conflict', 'Draft save should fail with lease conflict details.')

  const secondLock = await context.requestAs('advisor', `/api/forms/drafts/${draft.id}/lock`, {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({ leaseMs: 30_000 })
  })
  const save = await context.requestAs('advisor', `/api/forms/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: advisorHeaders,
    body: JSON.stringify({
      leaseId: secondLock.lock.leaseId,
      expectedRevisionId: secondLock.revisionId,
      data: { primaryGoal: 'Draft saved with active lock', riskTolerance: 'Conservative' }
    })
  })
  assert(save.ok === true, 'Advisor should save draft after lock reacquisition.')

  const template = await context.requestAs('admin', '/api/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'E2E Mapping Template',
      fileName: 'e2e-template.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })

  const publishedTemplate = await context.requestAs('admin', `/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'E2E template publish for submission coverage.' })
  })
  assert(publishedTemplate.status === 'published', 'Document template should publish for template-to-submission flow.')

  const submittedForm = await context.requestAs('advisor', '/api/forms/submissions', {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Submit from advisor flow', riskTolerance: 'Moderate' }
    })
  })
  assert(submittedForm.status === 'submitted', 'Advisor submission should be persisted as submitted.')

  const portalLink = await context.requestAs('advisor', '/api/portal-links', {
    method: 'POST',
    headers: advisorHeaders,
    body: JSON.stringify({ profileId: profile.id, templateIds: [formTemplate.id], expiresInHours: 2, maxUses: 5 })
  })

  const portalDraft = await context.request(`/api/portal/${portalLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'draft',
      data: { primaryGoal: 'Portal draft value', riskTolerance: 'Low' }
    })
  })
  assert(portalDraft.status === 'draft', 'Portal should allow draft save.')

  const portalSubmitted = await context.request(`/api/portal/${portalLink.token}/submissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Portal final submission', riskTolerance: 'Low' }
    })
  })
  assert(portalSubmitted.status === 'submitted', 'Portal should allow submit after draft save.')

  const portalState = await context.request(`/api/portal/${portalLink.token}`)
  const hasDraft = portalState.submissions.some((entry) => entry.status === 'draft' && entry.id === portalDraft.id)
  const hasSubmitted = portalState.submissions.some(
    (entry) => entry.status === 'submitted' && entry.id === portalSubmitted.id
  )
  assert(hasDraft, 'Portal submission list should include the saved draft.')
  assert(hasSubmitted, 'Portal submission list should include the submitted record.')

  const details = {
    suite: 'integration-e2e-workflows',
    users: {
      admin: registration.user.email,
      advisor: advisorAccepted.user.email
    },
    ids: {
      profileId: profile.id,
      formTemplateId: formTemplate.id,
      documentTemplateId: template.id,
      advisorDraftId: draft.id,
      advisorSubmissionId: submittedForm.id,
      portalDraftId: portalDraft.id,
      portalSubmissionId: portalSubmitted.id
    },
    customFields: {
      profileValues: profile.extensions?.values || {},
      profileDetailValues: profileDetail.profile?.extensions?.values || {}
    }
  }

  evidence.finalize({ status: 'passed', details })
  console.log(JSON.stringify(details, null, 2))
} catch (error) {
  evidence.finalize({ status: 'failed', error })
  throw error
} finally {
  await context.shutdown()
}
