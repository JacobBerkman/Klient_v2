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


  const formTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Export Intake',
      sections: [
        {
          title: 'Income',
          key: 'income',
          fields: [
            { key: 'salary', label: 'Salary', type: 'number' },
            { key: 'startDate', label: 'Start Date', type: 'date' },
            { key: 'isRetired', label: 'Retired', type: 'checkbox' }
          ]
        }
      ]
    })
  })
  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: {
        salary: 123456.78,
        startDate: '2024-04-10',
        isRetired: false
      }
    })
  })

  await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mappings: [
        { pdfField: 'client_name', sourcePath: 'profile.firstName' },
        { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } },
        { pdfField: 'started', sourcePath: 'startDate', transform: { type: 'date' } },
        { pdfField: 'retired', sourcePath: 'isRetired', transform: { type: 'checkbox' } },
        { pdfField: 'missing_with_default', sourcePath: 'missing.path', defaultValue: 'N/A' }
      ]
    })
  })

  const completedJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
  })

  const duplicateA = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
  })
  const duplicateB = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': duplicateA.idempotencyKey },
    body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
  })


  const xlsxJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'xlsx' })
  })

  const flakyJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      submissionId: submission.id,
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
      submissionId: submission.id,
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

  const unauthorizedDownload = await fetch(`http://127.0.0.1:${context.port}/api/analytics/export`)
  assert(unauthorizedDownload.status === 401, 'Analytics export download should require authentication')
  const authorizedDownload = await fetch(`http://127.0.0.1:${context.port}/api/analytics/export`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const csvDownload = await authorizedDownload.text()
  const downloadDisposition = authorizedDownload.headers.get('content-disposition') || ''
  const downloadType = authorizedDownload.headers.get('content-type') || ''

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
    assert(typeof completed?.output?.artifact?.templateVersion === 'string', 'Expected template version metadata')
    assert(typeof completed?.output?.artifact?.mappingVersionHash === 'string', 'Expected mapping version hash metadata')
    assert(typeof completed?.output?.preview?.generatedAt === 'string', 'Expected generated timestamp metadata')
    const byField = Object.fromEntries((completed?.output?.preview?.rows || []).map((row) => [row.pdfField, row.value]))
    assert(byField.client_name === 'Export', 'Expected profile mapping value in preview rows')
    assert(byField.salary === '$123,456.78', 'Expected currency transform to format salary')
    assert(byField.started === '2024-04-10', 'Expected date transform output')
    assert(byField.retired === 'No', 'Expected checkbox transform output')
    assert(byField.missing_with_default === 'N/A', 'Expected defaultValue fallback output')
    assert(completed?.output?.artifact?.checksum === completed?.output?.object?.checksum, 'Expected checksum stability across metadata')
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
  assert(authorizedDownload.status === 200, 'Analytics export download should succeed for authorized user')
  assert(downloadType === 'text/csv; charset=utf-8', 'Analytics export should return CSV content type')
  assert(
    /^attachment; filename=\"analytics-report-\d{4}-\d{2}-\d{2}\.csv\"$/.test(downloadDisposition),
    'Analytics export should return attachment filename header'
  )
  assert(csvDownload.includes('funnel'), 'Analytics export should return CSV payload')

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
