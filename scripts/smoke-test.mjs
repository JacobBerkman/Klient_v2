import { assert, createTestContext } from './test-harness.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidence = createEvidenceRecorder({
  gate: 'smoke',
  defaultFile: 'smoke-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SMOKE_FILE',
  command: 'npm run test:smoke'
})

const context = await createTestContext('smoke')
const workerScript = fileURLToPath(new URL('./export-worker.mjs', import.meta.url))

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function runWorkerTick(ctx, extraEnv = {}) {
  const result = spawnSync(process.execPath, [workerScript], {
    cwd: ctx.testCwd,
    env: {
      ...process.env,
      EXPORT_WORKER_ONCE: '1',
      EXPORT_WORKER_POLL_MS: '25',
      EXPORT_WORKER_LEASE_MS: '5000',
      EXPORT_WORKER_BATCH_SIZE: '10',
      NODE_ENV: 'test',
      ALLOW_DEV_FALLBACK_APP_SECRET: 'true',
      ...extraEnv
    },
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`Export worker tick failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function waitForExportCompletion(ctx, exportIds, { maxTicks = 30 } = {}) {
  const remaining = new Set(exportIds)
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    runWorkerTick(ctx)
    const exportsList = await ctx.request('/api/exports?sort=updatedAt_desc', {
      headers: ctx.authHeaders()
    })
    for (const entry of exportsList) {
      if (!remaining.has(entry.id)) continue
      if (entry.status === 'completed') remaining.delete(entry.id)
    }
    if (remaining.size === 0) return exportsList.filter((entry) => exportIds.includes(entry.id))
    await wait(125)
  }
  return []
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

  const completedExports = await waitForExportCompletion(context, [exportJob.id, flakyJob.id])
  const exportsList = await context.request('/api/exports?sort=updatedAt_desc', { headers: context.authHeaders() })
  const queueHealth = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })

  assert(exportsList.some((entry) => entry.id === exportJob.id), 'Export job missing from export list.')
  assert(exportsList.some((entry) => entry.id === flakyJob.id), 'Flaky export job missing from export list.')
  const trackedSmokeExport = exportsList.find((entry) => entry.id === exportJob.id) || null
  const trackedFlakyExport = exportsList.find((entry) => entry.id === flakyJob.id) || null
  assert(completedExports.length === 2, 'Smoke export jobs did not both complete via worker execution.')
  assert(trackedSmokeExport?.status === 'completed', 'Primary smoke export did not complete.')
  assert(trackedFlakyExport?.status === 'completed', 'Flaky smoke export did not recover and complete.')
  assert(publishResult.status === 'published', 'Template publish failed.')
  assert(typeof queueHealth?.queue?.pending === 'number', 'Queue health pending counter missing.')
  assert(typeof queueHealth?.queue?.machineState?.completed?.count === 'number', 'Queue machine completed count missing.')
  assert(typeof queueHealth?.queue?.machineState?.deadLetter?.count === 'number', 'Queue machine dead-letter count missing.')
  assert(queueHealth?.queue?.stalled === 0, 'Queue health should not report stalled worker leases in smoke.')

  assert(trackedSmokeExport?.artifactAvailable === true, 'Completed smoke export artifact should be marked ready.')
  const completedDownloadTarget = exportsList.find((entry) => entry.id === trackedSmokeExport.id && entry.status === 'completed')
  assert(Boolean(completedDownloadTarget), 'Completed smoke export should be available in export listing.')
  const download = await context.rawRequest(`/api/exports/${completedDownloadTarget.id}/download`, {
    headers: { Cookie: context.sessionCookie }
  })
  assert(download.status === 200, 'Completed smoke export should be downloadable.')
  const downloadType = download.headers.get('content-type') || ''
  assert(downloadType === 'application/pdf', 'Completed smoke export download should return PDF content type.')

  const summary = {
    ok: true,
    profileId: profile.id,
    templateId: template.id,
    exportJobId: trackedSmokeExport?.id || exportJob.id,
    exportStatus: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))?.status,
    exportArtifactReady: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))?.artifactAvailable,
    flakyJobId: flakyJob.id,
    flakyStatus: exportsList.find((entry) => entry.id === flakyJob.id)?.status,
    queuePending: queueHealth?.queue?.pending,
    queueStalled: queueHealth?.queue?.stalled
  }

  evidence.finalize({ status: 'passed', details: summary })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  evidence.finalize({ status: 'failed', error })
  throw error
} finally {
  await context.shutdown()
}
