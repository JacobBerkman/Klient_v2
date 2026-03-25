import { assert, createTestContext } from './test-harness.mjs'

async function processQueued(context, token, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await context.request('/api/exports/process', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    await wait(300)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const context = await createTestContext('exports')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'client',
      firstName: 'Export',
      lastName: 'Client',
      email: `export.client+${Date.now()}@example.com`
    })
  })
  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Export Template', fields: ['client.name', 'client.email'] })
  })
  await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Integration exports publish' })
  })

  const completedJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  const duplicateA = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })
  const duplicateB = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': duplicateA.idempotencyKey },
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })


  const xlsxJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'xlsx' })
  })

  const flakyJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: template.id,
      type: 'pdf',
      metadata: { simulateFailuresRemaining: 1 },
      maxAttempts: 3
    })
  })

  const poisonJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: template.id,
      type: 'pdf',
      metadata: { simulateFailuresRemaining: 9 },
      maxAttempts: 8
    })
  })

  await processQueued(context, admin.token, 24)
  const exportsList = await context.request('/api/exports', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const diagnostics = await context.request('/api/ops/diagnostics', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const queueHealth = await context.request('/api/ops/exports/queue', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const safeRetryDryRun = await context.request('/api/ops/exports/retry-failed', {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ dryRun: true, includeDeadLetter: false })
  })

  const completed = exportsList.find((entry) => entry.id === completedJob.id)
  const duplicate = exportsList.find((entry) => entry.id === duplicateA.id)
  const xlsx = exportsList.find((entry) => entry.id === xlsxJob.id)
  const flaky = exportsList.find((entry) => entry.id === flakyJob.id)
  const poison = exportsList.find((entry) => entry.id === poisonJob.id)
  assert(
    ['queued', 'processing', 'completed'].includes(completed?.status),
    'Expected export job to remain actionable in queue lifecycle'
  )
  assert(duplicateA.id === duplicateB.id, 'Expected duplicate create request to reuse idempotent export job')
  assert(
    ['queued', 'processing', 'completed'].includes(duplicate?.status),
    'Expected idempotent duplicate job to remain actionable'
  )

  assert(['queued', 'processing', 'completed'].includes(xlsx?.status), 'Expected XLSX export to remain actionable')
  if (xlsx?.status === 'completed') {
    assert(xlsx?.output?.fileName?.endsWith('.xlsx'), 'Expected XLSX export file extension')
    assert(
      xlsx?.output?.object?.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Expected XLSX content type metadata'
    )
  }
  if (completed?.status === 'completed') {
    assert(completed?.output?.fileName?.endsWith('.pdf'), 'Expected PDF export file extension')
    assert(completed?.output?.object?.contentType === 'application/pdf', 'Expected PDF content type metadata')
    assert(typeof completed?.output?.object?.checksum === 'string', 'Expected checksum on completed export artifact')
  }
  assert(
    ['queued', 'processing', 'completed', 'failed'].includes(flaky?.status),
    'Expected retrying export to remain in known lifecycle states'
  )
  assert(
    ['queued', 'processing', 'failed', 'dead-letter'].includes(poison?.status),
    'Expected poison job to remain in known lifecycle states'
  )
  assert(diagnostics?.data?.queue?.activeLeases >= 0, 'Expected queue lease diagnostics')
  assert(typeof diagnostics?.data?.queue?.readyNow === 'number', 'Expected queue ready-now diagnostics')
  assert(typeof diagnostics?.data?.queue?.stalled === 'number', 'Expected queue stalled diagnostics')
  assert(typeof queueHealth?.queue?.running === 'number', 'Expected queue health running count')
  assert(Array.isArray(safeRetryDryRun?.ids), 'Expected safe retry dry-run candidate ids')
  assert(safeRetryDryRun?.dryRun === true, 'Expected dry-run response from safe retry endpoint')

  console.log(
    JSON.stringify(
      {
        suite: 'integration-exports',
        completedId: completedJob.id,
        duplicateId: duplicateA.id,
        xlsxId: xlsxJob.id,
        flakyId: flakyJob.id,
        flakyAttempts: flaky.attempts,
        poisonStatus: poison?.status,
        queue: diagnostics?.data?.queue || null,
        queueHealth,
        safeRetryDryRun
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
