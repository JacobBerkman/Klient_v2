import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('tenancy')

try {
  await context.login('admin@demo.test', 'ChangeMe123!', 'admin')
  const adminHeaders = context.authHeaders('admin')

  const ownProfile = await context.requestAs('admin', '/api/profiles', {
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

  await context.login(registration.user.email, 'Isolation123!', 'secondFirm')
  const secondHeaders = context.authHeaders('secondFirm')
  const secondProfile = await context.requestAs('secondFirm', '/api/profiles', {
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

  const household = await context.requestAs('admin', '/api/households', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenant Household',
      primaryClientId: ownProfile.id
    })
  })

  const formTemplate = await context.requestAs('admin', '/api/forms/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenancy Intake',
      sections: [{ title: 'Basics', fields: [{ key: 'nickname', label: 'Nickname', type: 'text' }] }]
    })
  })

  const submission = await context.requestAs('admin', '/api/forms/submissions', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      clientId: ownProfile.id,
      templateId: formTemplate.id,
      status: 'draft',
      data: { nickname: 'Tenant' }
    })
  })

  const documentTemplate = await context.requestAs('admin', '/api/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Tenancy Packet',
      fileName: 'tenancy-packet.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  })

  const exportJob = await context.requestAs('admin', '/api/exports', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      clientId: ownProfile.id,
      templateId: documentTemplate.id,
      type: 'pdf'
    })
  })

  const firstFirmProfiles = await context.requestAs('admin', '/api/profiles?search=Tenant', { headers: context.authHeaders('admin') })
  const secondFirmProfiles = await context.requestAs('secondFirm', '/api/profiles?search=Tenant', { headers: secondHeaders })
  const firstFirmDashboard = await context.requestAs('admin', '/api/dashboard', { headers: context.authHeaders('admin') })
  const secondFirmDashboard = await context.requestAs('secondFirm', '/api/dashboard', { headers: secondHeaders })

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

  await context.requestExpectErrorAs('secondFirm', `/api/profiles/${ownProfile.id}`, { headers: secondHeaders }, [403, 404])
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/profiles/${ownProfile.id}`,
    {
      method: 'PATCH',
      headers: secondHeaders,
      body: JSON.stringify({ firstName: 'Compromised' })
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/households/${household.id}/members`,
    {
      method: 'POST',
      headers: secondHeaders,
      body: JSON.stringify({ clientId: secondProfile.id, role: 'member' })
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/forms/submissions/${submission.id}`,
    {
      method: 'PATCH',
      headers: secondHeaders,
      body: JSON.stringify({ status: 'submitted' })
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/forms/submissions/${submission.id}`,
    {
      method: 'DELETE',
      headers: secondHeaders
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/templates/${documentTemplate.id}/mappings`,
    {
      method: 'POST',
      headers: secondHeaders,
      body: JSON.stringify({ mappings: [{ key: 'x', source: 'y' }] })
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/templates/${documentTemplate.id}/publish`,
    {
      method: 'POST',
      headers: secondHeaders
    },
    [403, 404]
  )
  await context.requestExpectErrorAs(
    'secondFirm',
    `/api/exports/${exportJob.id}/retry`,
    {
      method: 'POST',
      headers: secondHeaders
    },
    [403, 404]
  )

  const secondAudit = await context.requestAs('secondFirm', '/api/audit', { headers: secondHeaders })
  assert(secondAudit.length > 0, 'Secondary firm audit stream should include its own tenant activity')
  assert(
    secondAudit.some((entry) => entry.entityId === secondProfile.id),
    'Secondary firm audit stream is missing expected in-tenant profile activity'
  )
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
