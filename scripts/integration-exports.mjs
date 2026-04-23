import { assert, createTestContext } from './test-harness.mjs'
import { runExportWorkerTick } from './export-worker-tick.mjs'
import { assertMappingsCoverPdfFields, mergeMappingsByPdfField } from './mapping-fixtures.mjs'
import { createTemplateWorkflowPdf, pdfBytesForJson } from './pdf-fixtures.mjs'

const TERMINAL_EXPORT_STATUSES = new Set(['completed', 'failed', 'dead-letter'])
let currentStep = 'startup'
let activeContext = null
let activeHeaders = null

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function processQueueTick(context) {
  currentStep = 'export worker tick'
  return runExportWorkerTick({
    cwd: context.testCwd,
    env: {
      EXPORT_WORKER_POLL_MS: '25',
      EXPORT_WORKER_LEASE_MS: '5000',
      EXPORT_WORKER_BATCH_SIZE: '10'
    }
  })
}

function crashAfterLeaseTick(context) {
  currentStep = 'crash-after-lease worker tick'
  runExportWorkerTick({
    cwd: context.testCwd,
    env: {
      EXPORT_WORKER_CRASH_AFTER_LEASE: '1',
      EXPORT_WORKER_LEASE_MS: '450',
      EXPORT_WORKER_BATCH_SIZE: '1'
    },
    label: 'crash-after-lease worker tick',
    expectedStatus: 92
  })
}

async function captureExportDiagnostics() {
  const snapshot = { step: currentStep }
  if (!activeContext) return snapshot

  try {
    snapshot.serverStatus = activeContext.serverStatus?.() || null
  } catch (error) {
    snapshot.serverStatusError = error?.message || String(error)
  }

  if (!activeHeaders) return snapshot

  try {
    snapshot.exports = await activeContext.request('/api/exports?sort=updatedAt_desc', { headers: activeHeaders })
  } catch (error) {
    snapshot.exportsError = error?.message || String(error)
  }

  try {
    snapshot.queue = await activeContext.request('/api/ops/exports/queue', { headers: activeContext.opsHeaders() })
  } catch (error) {
    snapshot.queueError = error?.message || String(error)
  }

  try {
    snapshot.diagnostics = await activeContext.request('/api/ops/diagnostics', {
      headers: activeContext.opsHeaders()
    })
  } catch (error) {
    snapshot.diagnosticsError = error?.message || String(error)
  }

  return snapshot
}

async function processQueued(context, times = 1) {
  for (let i = 0; i < times; i += 1) {
    processQueueTick(context)
    await wait(100)
  }
}

async function consumeResponse(response) {
  if (!response?.body) return
  await response.arrayBuffer()
}

async function waitForExport(context, matcher, { maxTicks = 40 } = {}) {
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    currentStep = `poll export queue ${attempt + 1}`
    const exportsList = await context.request('/api/exports?sort=updatedAt_desc', {
      headers: context.authHeaders()
    })
    const match = exportsList.find(matcher)
    if (match) return match
    processQueueTick(context)
    await wait(125)
  }

  return null
}

async function waitForTerminalExport(context, exportId, { maxTicks = 40 } = {}) {
  return waitForExport(context, (entry) => entry.id === exportId && TERMINAL_EXPORT_STATUSES.has(entry.status), {
    maxTicks
  })
}

async function waitForCompletedExport(context, exportIds, { maxTicks = 60 } = {}) {
  const idSet = new Set(exportIds)
  return waitForExport(context, (entry) => idSet.has(entry.id) && TERMINAL_EXPORT_STATUSES.has(entry.status), {
    maxTicks
  })
}

async function main() {
  const context = await createTestContext('exports')
  activeContext = context

  try {
    currentStep = 'login'
    await context.login()
    const headers = context.authHeaders()
    activeHeaders = headers

    currentStep = 'create client profile'
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
    currentStep = 'auto-build PDF template'
    const sourcePdf = await createTemplateWorkflowPdf()
    const template = await context.request('/api/templates/auto-build', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Export Template',
        fileName: 'export-template.pdf',
        fileBytes: pdfBytesForJson(sourcePdf)
      })
    })
    await context.request(`/api/templates/${template.id}/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Integration exports publish' })
    })

    currentStep = 'create manual form template'
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

    currentStep = 'save template mappings'
    const exportMappings = mergeMappingsByPdfField(template.mappings, [
      { pdfField: 'client_name', sourcePath: 'profile.firstName' },
      { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } },
      { pdfField: 'started', sourcePath: 'startDate', transform: { type: 'date' } },
      { pdfField: 'retired', sourcePath: 'isRetired', transform: { type: 'checkbox' } },
      { pdfField: 'missing_with_default', sourcePath: 'missing.path', defaultValue: 'N/A' }
    ])
    assertMappingsCoverPdfFields(exportMappings, template.extractedFields || template.extraction?.fields || [])
    await context.request(`/api/templates/${template.id}/mappings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mappings: exportMappings
      })
    })

    currentStep = 'queue export jobs'
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
    const stalledRecoveryJob = await context.request('/api/exports', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
    })

    currentStep = 'simulate stalled lease recovery'
    crashAfterLeaseTick(context)
    await wait(550)
    const queueAfterCrash = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })
    assert(
      queueAfterCrash?.queue?.stalled >= 1,
      'Expected stalled job detection when worker crashes after lease acquisition.'
    )

    currentStep = 'process queued exports'
    await processQueued(context, 24)
    currentStep = 'wait for terminal export states'
    const completedSettled = await waitForCompletedExport(context, [completedJob.id, duplicateA.id, xlsxJob.id])
    const flakySettled = await waitForTerminalExport(context, flakyJob.id)
    const poisonSettled = await waitForTerminalExport(context, poisonJob.id)
    currentStep = 'load export diagnostics'
    const exportsList = await context.request('/api/exports', {
      headers
    })
    const completedOnly = await context.request(`/api/exports?status=completed&sort=createdAt_desc`, {
      headers
    })
    const profileOnly = await context.request(
      `/api/exports?profileId=${encodeURIComponent(profile.id)}&sort=createdAt_asc`,
      {
        headers
      }
    )
    const futureWindow = await context.request(`/api/exports?fromDate=2099-01-01T00:00:00.000Z`, {
      headers
    })
    const diagnostics = await context.request('/api/ops/diagnostics', {
      headers: context.opsHeaders()
    })
    const queueHealth = await context.request('/api/ops/exports/queue', {
      headers: context.opsHeaders()
    })
    const safeRetryDryRun = await context.request('/api/ops/exports/retry-failed', {
      method: 'POST',
      headers,
      body: JSON.stringify({ dryRun: true, includeDeadLetter: false })
    })

    const unauthorizedDownload = await context.rawRequest('/api/analytics/export')
    assert(unauthorizedDownload.status === 401, 'Analytics export download should require authentication')
    await consumeResponse(unauthorizedDownload)
    const authorizedDownload = await context.rawRequest('/api/analytics/export', {
      headers: { Cookie: context.sessionCookie }
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
    currentStep = 'bulk retry failed exports'
    for (const candidate of retryCandidates) {
      const retried = await context.request(`/api/exports/${candidate.id}/retry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      })
      bulkRetryResults.push(retried)
    }
    const afterBulkRetry = await context.request(`/api/exports?status=queued&sort=updatedAt_desc`, {
      headers
    })
    currentStep = 'process retried exports'
    await processQueued(context, 6)
    const afterRetryProcessing = await context.request('/api/exports?sort=updatedAt_desc', {
      headers
    })
    const completedForAssertions =
      (completed?.status === 'completed' ? completed : completedSettled) ||
      exportsList.find((entry) => entry.id === completedJob.id) ||
      null
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
      assert(
        completedForAssertions?.artifactAvailable === true,
        'Expected completed export artifact to be marked as available'
      )
      assert(completedForAssertions?.output?.fileName?.endsWith('.pdf'), 'Expected PDF export file extension')
      assert(
        completedForAssertions?.output?.object?.contentType === 'application/pdf',
        'Expected PDF content type metadata'
      )
      assert(
        typeof completedForAssertions?.output?.object?.checksum === 'string',
        'Expected checksum on completed export artifact'
      )
      assert(
        typeof completedForAssertions?.output?.artifact?.templateVersion === 'string',
        'Expected template version metadata'
      )
      assert(
        typeof completedForAssertions?.output?.artifact?.mappingVersionHash === 'string',
        'Expected mapping version hash metadata'
      )
      assert(
        typeof completedForAssertions?.output?.preview?.generatedAt === 'string',
        'Expected generated timestamp metadata'
      )
      const byField = Object.fromEntries(
        (completedForAssertions?.output?.preview?.rows || []).map((row) => [row.pdfField, row.value])
      )
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
      flakySettled?.status === 'completed',
      'Expected flaky export to recover after transient failure and complete.'
    )
    assert(
      ['completed', 'retrying'].includes(flaky?.status),
      'Expected flaky export to complete after worker retry scheduling.'
    )
    assert(
      poisonSettled?.status === 'dead-letter',
      'Expected poison export to enter dead-letter state after repeated failures.'
    )
    assert(
      ['dead-letter', 'retrying'].includes(poison?.status),
      'Expected poison export to converge to dead-letter queue state.'
    )
    assert(
      ['failed', 'dead-letter', 'queued', 'processing'].includes(bulkRetryCandidate?.status),
      'Expected explicit bulk retry candidate to enter retry lifecycle'
    )
    assert(
      completedOnly.every((entry) => entry.status === 'completed'),
      'Expected status filter to only return completed jobs'
    )
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
    assert(
      queueHealth?.queue?.queued === queueHealth?.queue?.pending,
      'Expected queued counter to match pending semantics'
    )
    assert(Array.isArray(queueHealth?.queue?.activeLeases), 'Expected queue health active lease details')
    assert(
      typeof queueHealth?.queue?.machineState?.deadLetter?.count === 'number',
      'Expected queue dead-letter machine count'
    )
    assert(
      typeof queueHealth?.queue?.machineState?.completed?.count === 'number',
      'Expected queue completed machine count'
    )
    assert(
      queueHealth?.queue?.machineState?.deadLetter?.count >= 1,
      'Expected dead-letter machine state count to include poison job.'
    )
    assert(queueHealth?.queue?.stalled === 0, 'Expected stalled queue state recovery after subsequent worker ticks.')
    assert(
      typeof diagnostics?.data?.queue?.machineState?.retries?.active === 'number',
      'Expected diagnostics retries machine state'
    )
    assert(Array.isArray(safeRetryDryRun?.ids), 'Expected safe retry dry-run candidate ids')
    assert(safeRetryDryRun?.dryRun === true, 'Expected dry-run response from safe retry endpoint')
    assert(authorizedDownload.status === 200, 'Analytics export download should succeed for authorized user')
    assert(downloadType === 'text/csv; charset=utf-8', 'Analytics export should return CSV content type')
    assert(
      /^attachment; filename=\"analytics-report-\d{4}-\d{2}-\d{2}\.csv\"$/.test(downloadDisposition),
      'Analytics export should return attachment filename header'
    )
    assert(csvDownload.includes('funnel'), 'Analytics export should return CSV payload')
    const completedAfterRetry = afterRetryProcessing.find(
      (entry) => entry.id === (completedForAssertions?.id || completedJob.id)
    )
    if (completedAfterRetry?.status === 'completed') {
      currentStep = 'download completed PDF export'
      const completedDownload = await context.rawRequest(`/api/exports/${completedAfterRetry.id}/download`, {
        headers: { Cookie: context.sessionCookie }
      })
      assert(completedDownload.status === 200, 'Expected completed export to be downloadable')
      const completedDisposition = completedDownload.headers.get('content-disposition') || ''
      assert(completedDisposition.includes('.pdf'), 'Expected completed export download filename metadata')
      const completedDownloadType = completedDownload.headers.get('content-type') || ''
      assert(completedDownloadType === 'application/pdf', 'Expected completed export download content type')
      await consumeResponse(completedDownload)
    }
    const retriedProcessed = afterRetryProcessing.find((entry) => entry.id === bulkRetryJob.id)
    const stalledRecovered = afterRetryProcessing.find((entry) => entry.id === stalledRecoveryJob.id)
    assert(
      ['queued', 'retrying', 'running', 'completed', 'failed', 'dead-letter'].includes(retriedProcessed?.status),
      'Expected retried export to stay in known queue statuses after additional processing'
    )
    assert(
      ['retrying', 'running', 'completed', 'dead-letter'].includes(stalledRecovered?.status),
      'Expected stalled leased job to be recoverable by subsequent worker ticks'
    )
    if (retriedProcessed?.status === 'completed') {
      currentStep = 'download retried PDF export'
      const retriedDownload = await context.rawRequest(`/api/exports/${retriedProcessed.id}/download`, {
        headers: { Cookie: context.sessionCookie }
      })
      assert(retriedDownload.status === 200, 'Expected retried completed export to download successfully')
      await consumeResponse(retriedDownload)
    }

    const queueSummary = {
      pending: queueHealth?.queue?.pending ?? null,
      queued: queueHealth?.queue?.queued ?? null,
      retrying: queueHealth?.queue?.retrying ?? null,
      running: queueHealth?.queue?.running ?? null,
      completed: queueHealth?.queue?.machineState?.completed?.count ?? null,
      failed: queueHealth?.queue?.machineState?.failed?.count ?? null,
      deadLetter: queueHealth?.queue?.machineState?.deadLetter?.count ?? null,
      stalled: diagnostics?.data?.queue?.stalled ?? null
    }
    const safeRetrySummary = {
      dryRun: safeRetryDryRun?.dryRun ?? null,
      includeDeadLetter: safeRetryDryRun?.includeDeadLetter ?? null,
      candidateCount: safeRetryDryRun?.candidateCount ?? 0
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
          stalledRecoveryStatus:
            afterRetryProcessing.find((entry) => entry.id === stalledRecoveryJob.id)?.status || null,
          bulkRetryCandidate: bulkRetryJob.id,
          bulkRetriedIds: bulkRetryResults.map((entry) => entry.id),
          filtered: {
            completedOnly: completedOnly.length,
            profileOnly: profileOnly.length,
            futureWindow: futureWindow.length,
            queuedAfterRetry: afterBulkRetry.length,
            jobsAfterRetryProcessing: afterRetryProcessing.length
          },
          queue: queueSummary,
          safeRetry: safeRetrySummary
        },
        null,
        2
      )
    )
  } finally {
    await context.shutdown()
  }
}

main().catch((error) => {
  process.exitCode = 1
  console.error(`\n❌ integration-exports failed during step "${currentStep}": ${error.message}`)
  return captureExportDiagnostics().then((diagnostics) => {
    throw new Error(
      `[integration-exports] step="${currentStep}" failed: ${error?.message || String(error)}\n${JSON.stringify(
        diagnostics,
        null,
        2
      )}`
    )
  })
})
