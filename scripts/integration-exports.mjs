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
    headers: { Authorization: `Bearer ${admin.token}` }
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

  await processQueued(context, admin.token, 12)
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
  const flaky = exportsList.find((entry) => entry.id === flakyJob.id)
  const poison = exportsList.find((entry) => entry.id === poisonJob.id)
  assert(completed?.status === 'completed', 'Expected queued export processing to complete')
  assert(duplicateA.id === duplicateB.id, 'Expected duplicate create request to reuse idempotent export job')
  assert(duplicate?.status === 'completed', 'Expected idempotent duplicate job to complete once')
  assert(flaky?.status === 'completed', 'Expected retrying export to complete after worker restart')
  assert((flaky?.attempts || 0) >= 1, 'Expected retrying export attempts to increment')
  assert(poison?.status === 'dead-letter', 'Expected poison job to dead-letter')
  assert(
    poison?.failure?.reason === 'poison_job' || poison?.failure?.reason === 'max_attempts_exhausted',
    'Expected actionable dead-letter reason'
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
