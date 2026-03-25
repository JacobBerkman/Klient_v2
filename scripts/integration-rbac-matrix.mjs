import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('rbac-matrix')

function expectedFor(role, allowedRoles) {
  return allowedRoles.includes(role) ? 'allow' : 'deny'
}

try {
  const adminSession = await context.login()
  const adminHeaders = context.authHeaders(adminSession.token)

  const createRoleUser = async (role) => {
    const invite = await context.request('/api/invites', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ email: `${role}+${Date.now()}@test.local`, role })
    })
    return context.request('/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invite.token, firstName: role, lastName: 'Role', password: 'RolePass1234A' })
    })
  }

  const advisorSession = await createRoleUser('advisor')
  const readonlySession = await createRoleUser('readonly')
  const clientSession = await createRoleUser('client')

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'RBAC', lastName: 'Client', email: clientSession.user.email })
  })

  const household = await context.request('/api/households', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'RBAC Household', primaryClientId: profile.id })
  })

  const formTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'RBAC Form', sections: [] })
  })

  const docTemplate = await context.request('/api/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'RBAC Template', fileName: 'rbac.pdf' })
  })

  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ clientId: profile.id, templateId: formTemplate.id, status: 'draft', data: {} })
  })

  const exportJob = await context.request('/api/exports', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ clientId: profile.id, templateId: docTemplate.id, type: 'pdf' })
  })

  const portalLink = await context.request('/api/portal-links', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ profileId: profile.id })
  })

  const actors = {
    admin: adminSession.token,
    advisor: advisorSession.token,
    readonly: readonlySession.token,
    client: clientSession.token
  }

  const checks = [
    { path: '/api/session', method: 'GET', allow: ['admin', 'advisor', 'readonly', 'client'] },
    { path: '/api/dashboard', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: '/api/users', method: 'GET', allow: ['admin'] },
    { path: '/api/profiles', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    {
      path: '/api/profiles',
      method: 'POST',
      body: { kind: 'prospect', firstName: 'A', lastName: 'B' },
      allow: ['admin', 'advisor']
    },
    { path: `/api/profiles/${profile.id}`, method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: `/api/profiles/${profile.id}`, method: 'PATCH', body: { phone: '555' }, allow: ['admin', 'advisor'] },
    { path: `/api/profiles/${profile.id}/stage-history`, method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: `/api/profiles/${profile.id}/notes`, method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: `/api/profiles/${profile.id}/notes`, method: 'POST', body: { body: 'hello' }, allow: ['admin', 'advisor'] },
    { path: '/api/board', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: '/api/households', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    {
      path: '/api/households',
      method: 'POST',
      body: { name: 'H', primaryClientId: profile.id },
      allow: ['admin', 'advisor']
    },
    {
      path: `/api/households/${household.id}/members`,
      method: 'POST',
      body: { clientId: profile.id, role: 'member' },
      allow: ['admin', 'advisor']
    },
    { path: '/api/forms/templates', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: '/api/forms/templates', method: 'POST', body: { name: 'F', sections: [] }, allow: ['admin', 'advisor'] },
    { path: '/api/forms/submissions', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    {
      path: '/api/forms/submissions',
      method: 'POST',
      body: { clientId: profile.id, templateId: formTemplate.id, status: 'draft', data: {} },
      allow: ['admin', 'advisor']
    },
    { path: '/api/forms/drafts', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    {
      path: `/api/forms/submissions/${submission.id}`,
      method: 'PATCH',
      body: { status: 'submitted' },
      allow: ['admin', 'advisor']
    },
    { path: '/api/templates', method: 'GET', allow: ['admin', 'advisor'] },
    { path: '/api/templates', method: 'POST', body: { name: 'T' }, allow: ['admin', 'advisor'] },
    { path: `/api/templates/${docTemplate.id}/publish`, method: 'POST', body: {}, allow: ['admin', 'advisor'] },
    { path: '/api/exports', method: 'GET', allow: ['admin', 'advisor'] },
    {
      path: '/api/exports',
      method: 'POST',
      body: { clientId: profile.id, templateId: docTemplate.id, type: 'pdf' },
      allow: ['admin', 'advisor']
    },
    { path: '/api/audit', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: '/api/analytics', method: 'GET', allow: ['admin', 'advisor', 'readonly'] },
    { path: `/api/exports/${exportJob.id}/retry`, method: 'POST', body: {}, allow: ['admin', 'advisor'] },
    { path: '/api/client/workspace', method: 'GET', allow: ['client'] },
    {
      path: '/api/client/forms/submissions',
      method: 'POST',
      body: { templateId: formTemplate.id, status: 'draft', data: {} },
      allow: ['client']
    },
    { path: '/api/client/uploads', method: 'POST', body: { name: 'x' }, allow: ['client'] },
    {
      path: '/api/portal-links',
      method: 'POST',
      body: { profileId: profile.id },
      allow: ['admin', 'advisor', 'readonly']
    },
    { path: `/api/portal/${portalLink.token}`, method: 'GET', allow: ['admin', 'advisor', 'readonly', 'client'] }
  ]

  for (const check of checks) {
    for (const [role, token] of Object.entries(actors)) {
      const method = check.method || 'GET'
      const headers = method === 'GET' ? { Authorization: `Bearer ${token}` } : context.authHeaders(token)
      const options = { method, headers }
      if (check.body) options.body = JSON.stringify(check.body)
      const expectation = expectedFor(role, check.allow)
      if (expectation === 'allow') {
        await context.request(check.path, options)
      } else {
        let denied = null
        for (const status of [401, 403, 404]) {
          try {
            denied = await context.requestExpectError(check.path, options, status)
            break
          } catch {
            // try alternate denial status
          }
        }
        assert(Boolean(denied), `${role} must be denied ${method} ${check.path}`)
        assert(
          /Missing permission|Authentication required|not found|CSRF/i.test(denied.message),
          `${role} must be denied ${method} ${check.path}`
        )
      }
    }
  }

  console.log(JSON.stringify({ suite: 'integration-rbac-matrix', checks: checks.length }, null, 2))
} finally {
  await context.shutdown()
}
