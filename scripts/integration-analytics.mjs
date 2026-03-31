import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('analytics')

try {
  await context.login()
  const headers = context.authHeaders()

  const prospectA = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Aging',
      lastName: 'Prospect',
      email: `aging.prospect+${Date.now()}@example.com`,
      stage: 'analysis'
    })
  })
  const prospectB = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Converted',
      lastName: 'Prospect',
      email: `converted.prospect+${Date.now()}@example.com`,
      stage: 'completed'
    })
  })
  await context.request(`/api/profiles/${prospectA.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' })
  })
  await context.request(`/api/profiles/${prospectB.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ createdAt: '2026-01-15T00:00:00.000Z' })
  })

  const draft = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: prospectA.id, templateId: 'analytics-template', status: 'draft', data: { a: 1 } })
  })
  await context.request(`/api/forms/submissions/${draft.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      status: 'submitted',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-04T12:00:00.000Z'
    })
  })

  const [templates, clients] = await Promise.all([
    context.request('/api/templates', { headers }),
    context.request('/api/profiles?kind=client', { headers })
  ])
  await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: clients[0].id, templateId: templates[0].id, type: 'pdf' })
  })

  const analytics = await context.request(
    '/api/analytics?startDate=2026-01-01&endDate=2026-12-31&cohortBy=all',
    { headers }
  )
  const dashboard = await context.request('/api/analytics/dashboard?startDate=2026-01-01&endDate=2026-12-31', {
    headers: { Cookie: context.sessionCookie }
  })
  const csvResponse = await fetch(`http://127.0.0.1:${context.port}/api/analytics/export?startDate=2026-01-01`, {
    headers: { Cookie: context.sessionCookie }
  })
  const csv = await csvResponse.text()

  assert(Array.isArray(analytics.summary?.funnel), 'Funnel metrics missing')
  assert(Array.isArray(dashboard.bottlenecks), 'Bottlenecks not returned')
  assert(Array.isArray(dashboard.formCompletionLatency), 'Form latency aggregate missing')
  assert(Array.isArray(dashboard.exportUsage?.byAdvisor), 'Export usage by advisor missing')
  assert(dashboard.exportUsage?.byFirm?.total >= 1, 'Export usage by firm total should include seeded export')
  assert(
    dashboard.formCompletionLatency.some((entry) => entry.templateId === 'analytics-template' && entry.avgHours === 60),
    'Expected deterministic 60-hour form completion latency'
  )
  assert(csvResponse.ok, 'CSV export endpoint failed')
  assert(csv.includes('form_latency,analytics-template,avg_hours,60'), 'CSV missing form latency row')
  assert(csv.includes('export_usage_firm,queued,total,1'), 'CSV missing firm export usage row')

  console.log(
    JSON.stringify(
      {
        suite: 'integration-analytics',
        funnelStages: analytics.summary.funnel.length,
        topBottleneck: dashboard.bottlenecks[0]?.stage || null,
        formLatencyHours: dashboard.formCompletionLatency[0]?.avgHours || 0,
        advisorExportRows: dashboard.exportUsage.byAdvisor.length
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
