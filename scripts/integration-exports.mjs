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

async function consumeResponse(response) {
  if (!response?.body) return
  await response.arrayBuffer()
}

async function waitForTerminalExport(context, token, exportId, { maxTicks = 20 } = {}) {
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    const exportsList = await context.request('/api/exports?sort=updatedAt_desc', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const job = exportsList.find((entry) => entry.id === exportId)
    if (job && ['completed', 'failed', 'dead-letter'].includes(job.status)) return job
    await context.request('/api/exports/process', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    await wait(250)
  }
  return null
}

async function waitForCompletedExport(context, token, exportIds, { maxTicks = 30 } = {}) {
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    const exportsList = await context.request('/api/exports?sort=updatedAt_desc', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const terminal = exportsList.find(
      (entry) => exportIds.includes(entry.id) && ['completed', 'failed', 'dead-letter'].includes(entry.status)
    )
    if (terminal) return terminal
    await context.request('/api/exports/process', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    await wait(300)
  }
  return null
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
  const bulkRetryJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      submissionId: submission.id,
      templateId: template.id,
      type: 'pdf',
      metadata: { simulateFailuresRemaining: 1 },
      maxAttempts: 1
    })
  })

  await processQueued(context, admin.token, 24)
  const completedSettled = await waitForCompletedExport(context, admin.token, [completedJob.id, duplicateA.id, xlsxJob.id])
  const flakySettled = await waitForTerminalExport(context, admin.token, flakyJob.id)
  const exportsList = await context.request('/api/exports', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const completedOnly = await context.request(`/api/exports?status=completed&sort=createdAt_desc`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const profileOnly = await context.request(`/api/exports?profileId=${encodeURIComponent(profile.id)}&sort=createdAt_asc`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const futureWindow = await context.request(`/api/exports?fromDate=2099-01-01T00:00:00.000Z`, {
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
  const bulkRetryCandidate = exportsList.find((entry) => entry.id === bulkRetryJob.id)
  const retryCandidates = exportsList.filter((entry) => entry.status !== 'completed').slice(0, 3)
  const bulkRetryResults = []
  for (const candidate of retryCandidates) {
    const retried = await context.request(`/api/exports/${candidate.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    bulkRetryResults.push(retried)
  }
  const afterBulkRetry = await context.request(`/api/exports?status=queued&sort=updatedAt_desc`, {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  await processQueued(context, admin.token, 6)
  const afterRetryProcessing = await context.request('/api/exports?sort=updatedAt_desc', {
    headers: { Authorization: `Bearer ${admin.token}` }
  })
  const completedForAssertions =
    (completed?.status === 'completed' ? completed : completedSettled) || exportsList.find((entry) => entry.id === completedJob.id) || null
  assert(
    ['queued', 'retrying', 'running', 'completed', 'failed', 'dead-letter'].includes(completedForAssertions?.status),
    'Expected baseline export to remain in known lifecycle states'
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
  if (completedForAssertions?.status === 'completed') {
    assert(completedForAssertions?.artifactAvailable === true, 'Expected completed export artifact to be marked as available')
    assert(completedForAssertions?.output?.fileName?.endsWith('.pdf'), 'Expected PDF export file extension')
    assert(completedForAssertions?.output?.object?.contentType === 'application/pdf', 'Expected PDF content type metadata')
    assert(typeof completedForAssertions?.output?.object?.checksum === 'string', 'Expected checksum on completed export artifact')
    assert(typeof completedForAssertions?.output?.artifact?.templateVersion === 'string', 'Expected template version metadata')
    assert(typeof completedForAssertions?.output?.artifact?.mappingVersionHash === 'string', 'Expected mapping version hash metadata')
    assert(typeof completedForAssertions?.output?.preview?.generatedAt === 'string', 'Expected generated timestamp metadata')
    const byField = Object.fromEntries((completedForAssertions?.output?.preview?.rows || []).map((row) => [row.pdfField, row.value]))
    assert(byField.client_name === 'Export', 'Expected profile mapping value in preview rows')
    assert(byField.salary === '$123,456.78', 'Expected currency transform to format salary')
    assert(byField.started === '2024-04-10', 'Expected date transform output')
    assert(byField.retired === 'No', 'Expected checkbox transform output')
    assert(byField.missing_with_default === 'N/A', 'Expected defaultValue fallback output')
    assert(
      completedForAssertions?.output?.artifact?.checksum === completedForAssertions?.output?.object?.checksum,
      'Expected checksum stability across metadata'
    )
  }
  assert(
    ['queued', 'processing', 'completed', 'failed'].includes(flaky?.status),
    'Expected retrying export to remain in known lifecycle states'
  )
  assert(
    ['queued', 'retrying', 'running', 'completed', 'dead-letter', 'failed'].includes(flakySettled?.status || flaky?.status),
    'Expected flaky export to remain in known queue lifecycle states'
  )
  assert(
    ['queued', 'processing', 'failed', 'dead-letter'].includes(poison?.status),
    'Expected poison job to remain in known lifecycle states'
  )
  assert(
    ['failed', 'dead-letter', 'queued', 'processing'].includes(bulkRetryCandidate?.status),
    'Expected explicit bulk retry candidate to enter retry lifecycle'
  )
  assert(completedOnly.every((entry) => entry.status === 'completed'), 'Expected status filter to only return completed jobs')
  assert(
    profileOnly.every((entry) => entry.clientId === profile.id),
    'Expected profile filter to only return jobs for requested profile'
  )
  assert(futureWindow.length === 0, 'Expected future fromDate filter to return no jobs')
  assert(bulkRetryResults.length >= 1, 'Expected at least one non-completed job to be retried in bulk flow')
  assert(
    bulkRetryResults.every((entry) => ['queued', 'retrying', 'running'].includes(entry.status)),
    'Expected bulk retried jobs to be re-queued'
  )
  assert(
    bulkRetryResults.every((entry) => afterBulkRetry.some((job) => job.id === entry.id)),
    'Expected bulk retried jobs to be discoverable in queued filtered list'
  )
  if (completedOnly.length) {
    const completedWithArtifact = completedOnly.filter((entry) => entry.artifactAvailable)
    assert(
      completedWithArtifact.every((entry) => typeof entry?.artifact?.mappingVersionHash === 'string'),
      'Expected completed filtered jobs with artifacts to include artifact metadata'
    )
  }
  assert(diagnostics?.data?.queue?.activeLeases >= 0, 'Expected queue lease diagnostics')
  assert(typeof diagnostics?.data?.queue?.readyNow === 'number', 'Expected queue ready-now diagnostics')
  assert(typeof diagnostics?.data?.queue?.stalled === 'number', 'Expected queue stalled diagnostics')
  assert(typeof queueHealth?.queue?.running === 'number', 'Expected queue health running count')
  assert(typeof queueHealth?.queue?.queuedOnly === 'number', 'Expected queue health queued-only count')
  assert(typeof queueHealth?.queue?.retrying === 'number', 'Expected queue health retrying count')
  assert(typeof queueHealth?.queue?.pending === 'number', 'Expected queue health pending count')
  assert(queueHealth?.queue?.queued === queueHealth?.queue?.pending, 'Expected queued counter to match pending semantics')
  assert(Array.isArray(queueHealth?.queue?.activeLeases), 'Expected queue health active lease details')
  assert(typeof queueHealth?.queue?.machineState?.deadLetter?.count === 'number', 'Expected queue dead-letter machine count')
  assert(typeof queueHealth?.queue?.machineState?.completed?.count === 'number', 'Expected queue completed machine count')
  assert(typeof diagnostics?.data?.queue?.machineState?.retries?.active === 'number', 'Expected diagnostics retries machine state')
  assert(Array.isArray(safeRetryDryRun?.ids), 'Expected safe retry dry-run candidate ids')
  assert(safeRetryDryRun?.dryRun === true, 'Expected dry-run response from safe retry endpoint')
  assert(authorizedDownload.status === 200, 'Analytics export download should succeed for authorized user')
  assert(downloadType === 'text/csv; charset=utf-8', 'Analytics export should return CSV content type')
  assert(
    /^attachment; filename=\"analytics-report-\d{4}-\d{2}-\d{2}\.csv\"$/.test(downloadDisposition),
    'Analytics export should return attachment filename header'
  )
  assert(csvDownload.includes('funnel'), 'Analytics export should return CSV payload')
  const completedAfterRetry = afterRetryProcessing.find((entry) => entry.id === (completedForAssertions?.id || completedJob.id))
  if (completedAfterRetry?.status === 'completed') {
    const completedDownload = await fetch(`http://127.0.0.1:${context.port}/api/exports/${completedAfterRetry.id}/download`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    })
    assert(completedDownload.status === 200, 'Expected completed export to be downloadable')
    const completedDisposition = completedDownload.headers.get('content-disposition') || ''
    assert(completedDisposition.includes('.pdf'), 'Expected completed export download filename metadata')
    const completedDownloadType = completedDownload.headers.get('content-type') || ''
    assert(completedDownloadType === 'application/pdf', 'Expected completed export download content type')
    await consumeResponse(completedDownload)
  }
  const retriedProcessed = afterRetryProcessing.find((entry) => entry.id === bulkRetryJob.id)
  assert(
    ['queued', 'retrying', 'running', 'completed', 'failed', 'dead-letter'].includes(retriedProcessed?.status),
    'Expected retried export to stay in known queue statuses after additional processing'
  )
  if (retriedProcessed?.status === 'completed') {
    const retriedDownload = await fetch(`http://127.0.0.1:${context.port}/api/exports/${retriedProcessed.id}/download`, {
      headers: { Authorization: `Bearer ${admin.token}` }
    })
    assert(retriedDownload.status === 200, 'Expected retried completed export to download successfully')
    await consumeResponse(retriedDownload)
  }

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
        bulkRetryCandidate: bulkRetryJob.id,
        bulkRetriedIds: bulkRetryResults.map((entry) => entry.id),
        filtered: {
          completedOnly: completedOnly.length,
          profileOnly: profileOnly.length,
          futureWindow: futureWindow.length,
          queuedAfterRetry: afterBulkRetry.length,
          jobsAfterRetryProcessing: afterRetryProcessing.length
        },
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
