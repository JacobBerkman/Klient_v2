import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('rbac')

try {
  const admin = await context.login()
  const adminHeaders = context.authHeaders(admin.token)

  const invite = await context.request('/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `readonly+${Date.now()}@test.local`, role: 'readonly' })
  })

  const readonly = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' })
  })

  const advisorInvite = await context.request('/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `advisor+${Date.now()}@test.local`, role: 'advisor' })
  })

  const advisor = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: advisorInvite.token, firstName: 'Ad', lastName: 'Visor', password: 'Advisor1234!' })
  })
  const clientInvite = await context.request('/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `client+${Date.now()}@test.local`, role: 'client' })
  })
  const client = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: clientInvite.token, firstName: 'Cli', lastName: 'Ent', password: 'Client1234AA!' })
  })

  await context.request('/api/profiles', { headers: { Authorization: `Bearer ${readonly.token}` } })
  const blockedProfileWrite = await context.requestExpectError('/api/profiles', {
    method: 'POST',
    headers: context.authHeaders(readonly.token),
    body: JSON.stringify({ kind: 'prospect', firstName: 'Blocked', lastName: 'User', email: 'blocked@example.com' })
  }, 403)
  const blockedTemplatePublish = await context.requestExpectError('/api/templates/0000/publish', {
    method: 'POST',
    headers: context.authHeaders(readonly.token),
    body: JSON.stringify({})
  }, 403)
  const blockedPortalLink = await context.requestExpectError('/api/portal-links', {
    method: 'POST',
    headers: context.authHeaders(readonly.token),
    body: JSON.stringify({ profileId: 'p1' })
  }, 403)

  const advisorInviteBlocked = await context.requestExpectError('/api/invites', {
    method: 'POST',
    headers: context.authHeaders(advisor.token),
    body: JSON.stringify({ email: `blocked+${Date.now()}@test.local`, role: 'client' })
  }, 403)
  const readonlyInviteBlocked = await context.requestExpectError('/api/invites', {
    method: 'POST',
    headers: context.authHeaders(readonly.token),
    body: JSON.stringify({ email: `readonly-blocked+${Date.now()}@test.local`, role: 'client' })
  }, 403)
  const readonlyUsersBlocked = await context.requestExpectError('/api/users', {
    method: 'GET',
    headers: { Authorization: `Bearer ${readonly.token}` }
  }, 403)
  const adminClientWorkspaceBlocked = await context.requestExpectError('/api/client/workspace', {
    method: 'GET',
    headers: { Authorization: `Bearer ${admin.token}` }
  }, 403)
  const clientDashboardBlocked = await context.requestExpectError('/api/dashboard', {
    method: 'GET',
    headers: { Authorization: `Bearer ${client.token}` }
  }, 403)
  const readonlyProfilesAllowed = await context.request('/api/profiles', { headers: { Authorization: `Bearer ${readonly.token}` } })

  assert(/Missing permission/.test(blockedProfileWrite.message), 'Readonly should not create profiles')
  assert(/Missing permission/.test(blockedTemplatePublish.message), 'Readonly should not publish templates')
  assert(/Missing permission/.test(blockedPortalLink.message), 'Readonly should not create portal links')
  assert(/Missing permission/.test(advisorInviteBlocked.message), 'Non-admin should not invite users')
  assert(/Missing permission/.test(readonlyInviteBlocked.message), 'Readonly should not invite users')
  assert(Array.isArray(readonlyProfilesAllowed), 'Readonly should still read profiles')
  assert(/Missing permission/.test(readonlyUsersBlocked.message), 'Readonly should not list users')
  assert(/Missing permission/.test(adminClientWorkspaceBlocked.message), 'Admin should not access client workspace route')
  assert(/Missing permission/.test(clientDashboardBlocked.message), 'Client should not access advisor dashboard')

  console.log(
    JSON.stringify({ suite: 'integration-rbac', readonlyUserId: readonly.user.id, role: readonly.user.role }, null, 2)
  )
} finally {
  await context.shutdown()
}
