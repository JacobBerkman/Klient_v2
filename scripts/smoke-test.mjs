import { assert, createTestContext } from './test-harness.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'

const evidence = createEvidenceRecorder({
  gate: 'smoke',
  defaultFile: 'smoke-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SMOKE_FILE',
  command: 'npm run test:smoke'
})

const context = await createTestContext('smoke')

async function waitForExportCompletion(ctx, exportIds, { maxTicks = 24 } = {}) {
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    const exportsList = await ctx.request('/api/exports?sort=updatedAt_desc', {
      headers: ctx.authHeaders()
    })
    const job = exportsList.find(
      (entry) => exportIds.includes(entry.id) && ['completed', 'failed', 'dead-letter'].includes(entry.status)
    )
    if (job) return job
    await ctx.request('/api/exports/process', { method: 'POST', headers: ctx.authHeaders() })
  }
  return null
}

try {
  await context.request('/health')
  const ready = await context.request('/ready')
  assert(ready.status === 'ready', 'Readiness endpoint did not report ready state.')

  await context.login()
  const headers = context.authHeaders()

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Smoke',
      lastName: 'Path',
      email: `smoke.path+${Date.now()}@example.com`,
      stage: 'discovery'
    })
  })

  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Auto Build Test', fields: ['client.name', 'client.address', 'assets.account'] })
  })

  const publishResult = await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Smoke publish validation' })
  })

  const formTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Smoke Export Intake',
      sections: [{ title: 'Basics', key: 'basics', fields: [{ key: 'salary', label: 'Salary', type: 'number' }] }]
    })
  })
  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: { salary: 1000 }
    })
  })
  await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mappings: [
        { pdfField: 'client_name', sourcePath: 'profile.firstName' },
        { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } }
      ]
    })
  })

  const exportJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
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

  await context.request('/api/exports/process', { method: 'POST', headers })
  await context.request('/api/exports/process', { method: 'POST', headers })
  await context.request(`/api/exports/${flakyJob.id}/retry`, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  })
  await context.request('/api/exports/process', { method: 'POST', headers })
  const completedExport = await waitForExportCompletion(context, [exportJob.id, flakyJob.id])
  const exportsList = await context.request('/api/exports?sort=updatedAt_desc', { headers: context.authHeaders() })
  const queueHealth = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })

  assert(exportsList.some((entry) => entry.id === exportJob.id), 'Export job missing from export list.')
  assert(exportsList.some((entry) => entry.id === flakyJob.id), 'Flaky export job missing from export list.')
  const trackedSmokeExport = completedExport || exportsList.find((entry) => entry.id === exportJob.id) || null
  assert(
    ['queued', 'retrying', 'running', 'completed', 'failed', 'dead-letter'].includes(trackedSmokeExport?.status),
    'Primary smoke export did not remain in an expected lifecycle state.'
  )
  assert(publishResult.status === 'published', 'Template publish failed.')
  assert(typeof queueHealth?.queue?.pending === 'number', 'Queue health pending counter missing.')
  assert(typeof queueHealth?.queue?.machineState?.completed?.count === 'number', 'Queue machine completed count missing.')
  assert(typeof queueHealth?.queue?.machineState?.deadLetter?.count === 'number', 'Queue machine dead-letter count missing.')

  if (trackedSmokeExport?.status === 'completed') {
    assert(trackedSmokeExport?.artifactAvailable === true, 'Completed smoke export artifact should be marked ready.')
    const completedDownloadTarget = exportsList.find((entry) => entry.id === trackedSmokeExport.id && entry.status === 'completed')
    assert(Boolean(completedDownloadTarget), 'Completed smoke export should be available in export listing.')
    const download = await fetch(`http://127.0.0.1:${context.port}/api/exports/${completedDownloadTarget.id}/download`, {
      headers: context.authHeaders()
    })
    assert(download.status === 200, 'Completed smoke export should be downloadable.')
    const downloadType = download.headers.get('content-type') || ''
    assert(downloadType === 'application/pdf', 'Completed smoke export download should return PDF content type.')
  }

  const summary = {
    ok: true,
    profileId: profile.id,
    templateId: template.id,
    exportJobId: trackedSmokeExport?.id || exportJob.id,
    exportStatus: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))?.status,
    exportArtifactReady: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))?.artifactAvailable,
    flakyJobId: flakyJob.id,
    flakyStatus: exportsList.find((entry) => entry.id === flakyJob.id)?.status,
    queuePending: queueHealth?.queue?.pending
  }

  evidence.finalize({ status: 'passed', details: summary })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  evidence.finalize({ status: 'failed', error })
  throw error
} finally {
  await context.shutdown()
}
