import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('audit')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'client', firstName: 'Audit', lastName: 'Target', email: `audit+${Date.now()}@demo.test` })
  })

  await context.request(`/api/profiles/${profile.id}/sensitive`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })

  const household = await context.request('/api/households', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Audit Household', primaryClientId: profile.id })
  })

  const spouse = await context.request('/api/households/create-spouse', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      primaryClientId: profile.id,
      spouse: { kind: 'client', firstName: 'Audit', lastName: 'Spouse', email: `spouse+${Date.now()}@demo.test` }
    })
  })

  await context.request(`/api/households/${household.id}/members`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ clientId: spouse.id })
  })

  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Audit Template', fields: ['client.firstName'] })
  })

  await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }] })
  })

  await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Integration audit publish' })
  })

  const job = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  await context.request(`/api/exports/${job.id}/retry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` }
  })

  const audit = await context.request('/api/audit', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })

  const requiredActionGroups = [
    ['profile.sensitive_read', 'sensitive.read'],
    ['household.merge'],
    ['household.split'],
    ['document_template.mappings_updated'],
    ['document_template.published'],
    ['export_job.retry_requested']
  ]

  for (const group of requiredActionGroups) {
    assert(audit.some((entry) => group.includes(entry.action)), `missing audit action ${group.join(' or ')}`)
  }

  const sample = audit[0]
  for (const field of ['actor', 'firmId', 'entityType', 'entityId', 'action', 'before', 'after', 'requestId', 'ip', 'timestamp']) {
    assert(Object.prototype.hasOwnProperty.call(sample, field), `missing canonical audit field ${field}`)
  }
  for (const group of requiredActionGroups) {
    const event = audit.find((entry) => group.includes(entry.action))
    const label = group.join(' or ')
    assert(event.firmId, `audit action ${label} is missing firmId`)
  }

  console.log(
    JSON.stringify(
      { suite: 'integration-audit', total: audit.length, checkedActions: requiredActionGroups.flat() },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
