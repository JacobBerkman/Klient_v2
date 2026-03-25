import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('tenancy')

try {
  const admin = await context.login()
  const adminHeaders = context.authHeaders(admin.token)

  const ownProfile = await context.request('/api/profiles', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Tenant',
      lastName: 'One',
      email: `tenant.one+${Date.now()}@example.com`,
      stage: 'discovery'
    })
  })

  const registration = await context.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firmName: 'Isolation Capital',
      firstName: 'Iso',
      lastName: 'Admin',
      email: `iso-admin+${Date.now()}@test.local`,
      password: 'Isolation123!'
    })
  })

  const secondHeaders = context.authHeaders(registration.token)
  const secondProfile = await context.request('/api/profiles', {
    method: 'POST',
    headers: secondHeaders,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Tenant',
      lastName: 'Two',
      email: `tenant.two+${Date.now()}@example.com`,
      stage: 'analysis'
    })
  })

  const household = await context.request('/api/households', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenant Household',
      primaryClientId: ownProfile.id
    })
  })

  const formTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenancy Intake',
      sections: [{ title: 'Basics', fields: [{ key: 'nickname', label: 'Nickname', type: 'text' }] }]
    })
  })

  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      clientId: ownProfile.id,
      templateId: formTemplate.id,
      status: 'draft',
      data: { nickname: 'Tenant' }
    })
  })

  const documentTemplate = await context.request('/api/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenancy Packet',
      fileName: 'tenancy-packet.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })

  const exportJob = await context.request('/api/exports', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      clientId: ownProfile.id,
      templateId: documentTemplate.id,
      type: 'pdf'
    })
  })

  const firstFirmProfiles = await context.request('/api/profiles?search=Tenant', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const secondFirmProfiles = await context.request('/api/profiles?search=Tenant', {
    headers: { Authorization: `Bearer ${registration.token}` }
  })
  const firstFirmDashboard = await context.request('/api/dashboard', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const secondFirmDashboard = await context.request('/api/dashboard', {
    headers: { Authorization: `Bearer ${registration.token}` }
  })

  assert(
    firstFirmProfiles.some((profile) => profile.id === ownProfile.id),
    'Primary firm cannot see its own profile'
  )
  assert(!firstFirmProfiles.some((profile) => profile.id === secondProfile.id), 'Primary firm can see foreign profile')
  assert(
    secondFirmProfiles.some((profile) => profile.id === secondProfile.id),
    'Secondary firm cannot see its own profile'
  )
  assert(!secondFirmProfiles.some((profile) => profile.id === ownProfile.id), 'Secondary firm can see foreign profile')
  assert(firstFirmDashboard.firm.id !== secondFirmDashboard.firm.id, 'Dashboard firm IDs should differ across tenants')

  await context.requestExpectError(`/api/profiles/${ownProfile.id}`, { headers: secondHeaders }, [400, 404])
  await context.requestExpectError(
    `/api/profiles/${ownProfile.id}`,
    {
      method: 'PATCH',
      headers: secondHeaders,
      body: JSON.stringify({ firstName: 'Compromised' })
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/households/${household.id}/members`,
    {
      method: 'POST',
      headers: secondHeaders,
      body: JSON.stringify({ clientId: secondProfile.id, role: 'member' })
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/forms/submissions/${submission.id}`,
    {
      method: 'PATCH',
      headers: secondHeaders,
      body: JSON.stringify({ status: 'submitted' })
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/forms/submissions/${submission.id}`,
    {
      method: 'DELETE',
      headers: secondHeaders
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/templates/${documentTemplate.id}/mappings`,
    {
      method: 'POST',
      headers: secondHeaders,
      body: JSON.stringify({ mappings: [{ key: 'x', source: 'y' }] })
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/templates/${documentTemplate.id}/publish`,
    {
      method: 'POST',
      headers: secondHeaders
    },
    [400, 404]
  )
  await context.requestExpectError(
    `/api/exports/${exportJob.id}/retry`,
    {
      method: 'POST',
      headers: secondHeaders
    },
    [400, 404]
  )

  const secondAudit = await context.request('/api/audit', { headers: secondHeaders })
  assert(
    !secondAudit.some((entry) => entry.entityId === ownProfile.id || entry.entityId === household.id),
    'Secondary firm can see audit events from primary firm'
  )

  console.log(
    JSON.stringify(
      {
        suite: 'integration-tenancy',
        firstFirmId: firstFirmDashboard.firm.id,
        secondFirmId: secondFirmDashboard.firm.id,
        deniedEntityIds: [ownProfile.id, household.id, submission.id, documentTemplate.id, exportJob.id]
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
