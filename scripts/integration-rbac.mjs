import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('rbac')

try {
  await context.login('admin@demo.test', 'ChangeMe123!', 'admin')
  const adminHeaders = context.authHeaders('admin')

  const invite = await context.requestAs('admin', '/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `readonly+${Date.now()}@test.local`, role: 'readonly' })
  })

  const readonly = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' })
  })
  await context.login(readonly.user.email, 'Readonly123!', 'readonly')

  const advisorInvite = await context.requestAs('admin', '/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `advisor+${Date.now()}@test.local`, role: 'advisor' })
  })

  const advisor = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: advisorInvite.token, firstName: 'Ad', lastName: 'Visor', password: 'Advisor1234!' })
  })
  await context.login(advisor.user.email, 'Advisor1234!', 'advisor')
  const clientInvite = await context.requestAs('admin', '/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `client+${Date.now()}@test.local`, role: 'client' })
  })
  const client = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: clientInvite.token, firstName: 'Cli', lastName: 'Ent', password: 'Client1234AA!' })
  })
  await context.login(client.user.email, 'Client1234AA!', 'client')

  await context.requestAs('readonly', '/api/profiles', { headers: context.authHeaders('readonly') })
  const blockedProfileWrite = await context.requestExpectErrorAs('readonly', '/api/profiles', {
    method: 'POST',
    headers: context.authHeaders('readonly'),
    body: JSON.stringify({ kind: 'prospect', firstName: 'Blocked', lastName: 'User', email: 'blocked@example.com' })
  }, 403)
  const blockedTemplatePublish = await context.requestExpectErrorAs('readonly', '/api/templates/0000/publish', {
    method: 'POST',
    headers: context.authHeaders('readonly'),
    body: JSON.stringify({})
  }, 403)
  const blockedPortalLink = await context.requestExpectErrorAs('readonly', '/api/portal-links', {
    method: 'POST',
    headers: context.authHeaders('readonly'),
    body: JSON.stringify({ profileId: 'p1' })
  }, 403)

  const advisorInviteBlocked = await context.requestExpectErrorAs('advisor', '/api/invites', {
    method: 'POST',
    headers: context.authHeaders('advisor'),
    body: JSON.stringify({ email: `blocked+${Date.now()}@test.local`, role: 'client' })
  }, 403)
  const advisorOpsDiagnostics = await context.requestAs('advisor', '/api/ops/diagnostics', {
    method: 'GET',
    headers: context.opsHeaders()
  })
  const advisorOpsQueue = await context.requestAs('advisor', '/api/ops/exports/queue', {
    method: 'GET',
    headers: context.opsHeaders()
  })
  const advisorOpsRetryFailedBlocked = await context.requestExpectErrorAs('advisor', '/api/ops/exports/retry-failed', {
    method: 'POST',
    headers: context.authHeaders('advisor'),
    body: JSON.stringify({ dryRun: true })
  }, 403)
  const readonlyExportRetryBlocked = await context.requestExpectErrorAs('readonly', '/api/exports/demo-export/retry', {
    method: 'POST',
    headers: context.authHeaders('readonly'),
    body: JSON.stringify({})
  }, 403)
  const readonlyInviteBlocked = await context.requestExpectErrorAs('readonly', '/api/invites', {
    method: 'POST',
    headers: context.authHeaders('readonly'),
    body: JSON.stringify({ email: `readonly-blocked+${Date.now()}@test.local`, role: 'client' })
  }, 403)
  const readonlyUsersBlocked = await context.requestExpectErrorAs('readonly', '/api/users', {
    method: 'GET',
    headers: context.authHeaders('readonly')
  }, 403)
  const adminClientWorkspaceBlocked = await context.requestExpectErrorAs('admin', '/api/client/workspace', {
    method: 'GET',
    headers: context.authHeaders('admin')
  }, 403)
  const clientDashboardBlocked = await context.requestExpectErrorAs('client', '/api/dashboard', {
    method: 'GET',
    headers: context.authHeaders('client')
  }, 403)
  const readonlyProfilesAllowed = await context.requestAs('readonly', '/api/profiles', { headers: context.authHeaders('readonly') })

  assert(Boolean(blockedProfileWrite), 'Readonly should not create profiles')
  assert(Boolean(blockedTemplatePublish), 'Readonly should not publish templates')
  assert(Boolean(blockedPortalLink), 'Readonly should not create portal links')
  assert(Boolean(advisorInviteBlocked), 'Non-admin should not invite users')
  assert(Boolean(advisorOpsDiagnostics), 'Ops diagnostics should be accessible with ops token')
  assert(Boolean(advisorOpsQueue), 'Ops export queue should be accessible with ops token')
  assert(Boolean(advisorOpsRetryFailedBlocked), 'Advisor should not retry failed ops exports')
  assert(Boolean(readonlyExportRetryBlocked), 'Readonly should not retry exports')
  assert(Boolean(readonlyInviteBlocked), 'Readonly should not invite users')
  assert(Array.isArray(readonlyProfilesAllowed), 'Readonly should still read profiles')
  assert(Boolean(readonlyUsersBlocked), 'Readonly should not list users')
  assert(Boolean(adminClientWorkspaceBlocked), 'Admin should not access client workspace route')
  assert(Boolean(clientDashboardBlocked), 'Client should not access advisor dashboard')

  console.log(
    JSON.stringify({ suite: 'integration-rbac', readonlyUserId: readonly.user.id, role: readonly.user.role }, null, 2)
  )
} finally {
  await context.shutdown()
}
