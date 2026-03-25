import { readFileSync } from 'node:fs'
import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('rbac-matrix')
const policyMatrix = JSON.parse(readFileSync(new URL('../apps/api/src/modules/shared/policy-matrix.json', import.meta.url), 'utf8'))

const roles = ['admin', 'advisor', 'readonly', 'client']

function allowedRoles(guard) {
  return new Set((policyMatrix[guard] || []).filter((role) => role !== 'anonymous'))
}

function ensureGuardCoverage(checks) {
  const missingGuards = []
  for (const check of checks) {
    if (!Object.prototype.hasOwnProperty.call(policyMatrix, check.guard)) {
      missingGuards.push(`${check.guard} (${check.method} ${check.path})`)
    }
  }
  assert(missingGuards.length === 0, `RBAC matrix checks reference unknown guards: ${missingGuards.join(', ')}`)
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
    body: JSON.stringify({ profileId: profile.id, maxUses: 10 })
  })

  const actors = {
    admin: adminSession.token,
    advisor: advisorSession.token,
    readonly: readonlySession.token,
    client: clientSession.token
  }

  const checks = [
    { path: '/api/session', method: 'GET', guard: 'canReadSession' },
    { path: '/api/ops/diagnostics', method: 'GET', guard: 'canReadDiagnostics' },
    { path: '/api/dashboard', method: 'GET', guard: 'canViewDashboard' },
    { path: '/api/users', method: 'GET', guard: 'canReadUsers' },
    { path: '/api/profiles', method: 'GET', guard: 'canReadProfiles' },
    { path: '/api/profiles', method: 'POST', body: { kind: 'prospect', firstName: 'A', lastName: 'B' }, guard: 'canWriteProfiles' },
    { path: `/api/profiles/${profile.id}`, method: 'GET', guard: 'canReadProfiles' },
    { path: `/api/profiles/${profile.id}`, method: 'PATCH', body: { phone: '555' }, guard: 'canWriteProfiles' },
    { path: `/api/profiles/${profile.id}/stage-history`, method: 'GET', guard: 'canReadProfiles' },
    { path: `/api/profiles/${profile.id}/notes`, method: 'GET', guard: 'canReadProfiles' },
    { path: `/api/profiles/${profile.id}/notes`, method: 'POST', body: { body: 'hello' }, guard: 'canWriteProfiles' },
    { path: '/api/board', method: 'GET', guard: 'canReadProfiles' },
    { path: '/api/households', method: 'GET', guard: 'canReadHouseholds' },
    { path: '/api/households', method: 'POST', body: { name: 'H', primaryClientId: profile.id }, guard: 'canWriteHouseholds' },
    { path: `/api/households/${household.id}/members`, method: 'POST', body: { clientId: profile.id, role: 'member' }, guard: 'canWriteHouseholds' },
    { path: '/api/forms/templates', method: 'GET', guard: 'canReadForms' },
    { path: '/api/forms/templates', method: 'POST', body: { name: 'F', sections: [] }, guard: 'canWriteForms' },
    { path: '/api/forms/submissions', method: 'GET', guard: 'canReadForms' },
    { path: '/api/forms/submissions', method: 'POST', body: { clientId: profile.id, templateId: formTemplate.id, status: 'draft', data: {} }, guard: 'canWriteForms' },
    { path: '/api/forms/drafts', method: 'GET', guard: 'canReadForms' },
    { path: `/api/forms/submissions/${submission.id}`, method: 'PATCH', body: { status: 'submitted' }, guard: 'canWriteForms' },
    { path: '/api/templates', method: 'GET', guard: 'canReadTemplate' },
    { path: '/api/templates', method: 'POST', body: { name: 'T' }, guard: 'canEditTemplate' },
    {
      path: `/api/templates/${docTemplate.id}/publish`,
      method: 'POST',
      body: { versionBump: '1.0.0', changelog: 'RBAC matrix publish check' },
      guard: 'canPublishTemplate'
    },
    { path: '/api/exports', method: 'GET', guard: 'canReadExports' },
    { path: '/api/exports', method: 'POST', body: { clientId: profile.id, templateId: docTemplate.id, type: 'pdf' }, guard: 'canWriteExports' },
    { path: '/api/exports/process', method: 'POST', body: {}, guard: 'canProcessExports' },
    { path: `/api/exports/${exportJob.id}/retry`, method: 'POST', body: {}, guard: 'canWriteExports' },
    { path: '/api/audit', method: 'GET', guard: 'canReadAudit' },
    { path: '/api/analytics', method: 'GET', guard: 'canReadAnalytics' },
    { path: '/api/client/workspace', method: 'GET', guard: 'canReadClientWorkspace' },
    { path: '/api/client/forms/submissions', method: 'POST', body: { templateId: formTemplate.id, status: 'draft', data: {} }, guard: 'canWriteClientWorkspace' },
    { path: '/api/client/uploads', method: 'POST', body: { name: 'x' }, guard: 'canWriteClientWorkspace' },
    { path: '/api/portal-links', method: 'POST', body: { profileId: profile.id }, guard: 'canCreatePortalLink' },
    { path: `/api/portal/${portalLink.token}`, method: 'GET', guard: 'canReadPortal', scopeRoles: ['client'] },
    {
      path: `/api/portal/${portalLink.token}/submissions`,
      method: 'POST',
      body: { templateId: formTemplate.id, status: 'draft', data: {} },
      guard: 'canSubmitPortal',
      scopeRoles: ['client']
    },
    {
      path: `/api/portal/${portalLink.token}/uploads`,
      method: 'POST',
      body: { name: 'client-doc' },
      guard: 'canUploadPortal',
      scopeRoles: ['client']
    }
  ]

  ensureGuardCoverage(checks)
  const observedDenials = new Set()

  for (const check of checks) {
    const allow = allowedRoles(check.guard)
    assert(allow.size > 0, `Guard ${check.guard} has no allowed authenticated roles in policy matrix`)
    for (const role of roles) {
      if (Array.isArray(check.scopeRoles) && !check.scopeRoles.includes(role)) {
        continue
      }
      const token = actors[role]
      const method = check.method || 'GET'
      const headers = method === 'GET' ? { Authorization: `Bearer ${token}` } : context.authHeaders(token)
      const options = { method, headers }
      if (check.body) options.body = JSON.stringify(check.body)

      if (allow.has(role)) {
        await context.request(check.path, options)
      } else {
        let denied = null
        for (const status of [401, 403, 404]) {
          try {
            denied = await context.requestExpectError(check.path, options, status)
            observedDenials.add(`${role}:${check.guard}`)
            break
          } catch {
            // try alternate denial status
          }
        }
        assert(Boolean(denied), `${role} must be denied ${method} ${check.path}`)
      }
    }
  }

  assert(observedDenials.size > 0, 'RBAC matrix did not observe any denied routes; deny-path coverage is required')

  console.log(
    JSON.stringify({ suite: 'integration-rbac-matrix', checks: checks.length, denyPathsObserved: observedDenials.size }, null, 2)
  )
} finally {
  await context.shutdown()
}
