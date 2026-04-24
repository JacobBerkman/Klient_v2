import { assert, createTestContext } from './test-harness.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'
import {
  captureExportDiagnostics,
  logSuiteStep,
  runSuiteWorkerTick,
  wait,
  waitForExportIds
} from './export-test-lifecycle.mjs'
import { assertMappingsCoverPdfFields, mergeMappingsByPdfField } from './mapping-fixtures.mjs'
import { createTemplateWorkflowPdf, pdfBytesForJson } from './pdf-fixtures.mjs'

const evidence = createEvidenceRecorder({
  gate: 'smoke',
  defaultFile: 'smoke-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SMOKE_FILE',
  command: 'npm run test:smoke'
})

let currentStep = 'startup'

function runWorkerTick(ctx, extraEnv = {}) {
  return runSuiteWorkerTick(ctx, {
    suite: 'smoke',
    step: currentStep,
    envOverrides: extraEnv
  })
}

async function waitForExportCompletion(ctx, exportIds, { maxTicks = 30 } = {}) {
  return waitForExportIds(ctx, {
    suite: 'smoke',
    headers: ctx.authHeaders(),
    exportIds,
    currentStepPrefix: 'export completion polling',
    runWorkerTick: () => runWorkerTick(ctx),
    terminalStatuses: ['completed'],
    maxTicks
  })
}

let context = null

try {
  context = await createTestContext('smoke')
  currentStep = 'health checks'
  logSuiteStep('smoke', currentStep)
  await context.request('/health')
  const ready = await context.request('/ready')
  assert(ready.status === 'ready', 'Readiness endpoint did not report ready state.')

  currentStep = 'login'
  logSuiteStep('smoke', currentStep)
  await context.login()
  const headers = context.authHeaders()

  currentStep = 'create prospect profile'
  logSuiteStep('smoke', currentStep)
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

  currentStep = 'auto-build PDF template'
  logSuiteStep('smoke', currentStep)
  const sourcePdf = await createTemplateWorkflowPdf()
  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Auto Build Test',
      fileName: 'smoke-template.pdf',
      fileBytes: pdfBytesForJson(sourcePdf)
    })
  })
  assert(template.extraction?.status === 'completed', 'Smoke PDF template extraction should complete.')
  assert(template.linkedFormTemplateId, 'Smoke PDF auto-build should create a linked form template.')
  assert(template.sourceArtifact?.key, 'Smoke PDF auto-build should persist the source artifact key.')

  currentStep = 'publish generated template'
  logSuiteStep('smoke', currentStep)
  const publishResult = await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Smoke publish validation' })
  })

  currentStep = 'load generated form template'
  logSuiteStep('smoke', currentStep)
  const formTemplates = await context.request('/api/forms/templates', { headers })
  const generatedFormTemplate = formTemplates.find((entry) => entry.id === template.linkedFormTemplateId)
  assert(
    generatedFormTemplate?.generatedFromDocumentTemplateId === template.id,
    'Generated form template linkage missing.'
  )
  currentStep = 'create submission from generated form'
  logSuiteStep('smoke', currentStep)
  const submission = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: generatedFormTemplate.id,
      status: 'submitted',
      data: {
        client_name: 'Smoke Path',
        salary: 1000,
        started: '2026-04-22',
        retired: false,
        missing_with_default: 'Smoke default path',
        dependents: [{ name: 'Smoke Dependent One' }, { name: 'Smoke Dependent Two' }]
      }
    })
  })
  const smokeMappings = mergeMappingsByPdfField(template.mappings, [
    { pdfField: 'client_name', sourcePath: 'client_name' },
    { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } },
    { pdfField: 'started', sourcePath: 'started', transform: { type: 'date' } },
    { pdfField: 'retired', sourcePath: 'retired', transform: { type: 'checkbox' } }
  ])
  assertMappingsCoverPdfFields(smokeMappings, template.extractedFields || template.extraction?.fields || [])
  currentStep = 'save template mappings'
  logSuiteStep('smoke', currentStep)
  await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mappings: smokeMappings
    })
  })

  currentStep = 'queue export jobs'
  logSuiteStep('smoke', currentStep)
  const exportJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
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

  currentStep = 'wait for export completion'
  logSuiteStep('smoke', currentStep)
  const completedExports = await waitForExportCompletion(context, [exportJob.id, xlsxJob.id, flakyJob.id])
  currentStep = 'load export queue health'
  logSuiteStep('smoke', currentStep)
  const exportsList = await context.request('/api/exports?sort=updatedAt_desc', { headers: context.authHeaders() })
  const queueHealth = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })

  assert(
    exportsList.some((entry) => entry.id === exportJob.id),
    'Export job missing from export list.'
  )
  assert(
    exportsList.some((entry) => entry.id === xlsxJob.id),
    'XLSX export job missing from export list.'
  )
  assert(
    exportsList.some((entry) => entry.id === flakyJob.id),
    'Flaky export job missing from export list.'
  )
  const trackedSmokeExport = exportsList.find((entry) => entry.id === exportJob.id) || null
  const trackedXlsxExport = exportsList.find((entry) => entry.id === xlsxJob.id) || null
  const trackedFlakyExport = exportsList.find((entry) => entry.id === flakyJob.id) || null
  assert(completedExports.length === 3, 'Smoke export jobs did not all complete via worker execution.')
  assert(trackedSmokeExport?.status === 'completed', 'Primary smoke export did not complete.')
  assert(trackedXlsxExport?.status === 'completed', 'XLSX smoke export did not complete.')
  assert(trackedFlakyExport?.status === 'completed', 'Flaky smoke export did not recover and complete.')
  assert(publishResult.status === 'published', 'Template publish failed.')
  assert(typeof queueHealth?.queue?.pending === 'number', 'Queue health pending counter missing.')
  assert(
    typeof queueHealth?.queue?.machineState?.completed?.count === 'number',
    'Queue machine completed count missing.'
  )
  assert(
    typeof queueHealth?.queue?.machineState?.deadLetter?.count === 'number',
    'Queue machine dead-letter count missing.'
  )
  assert(queueHealth?.queue?.stalled === 0, 'Queue health should not report stalled worker leases in smoke.')

  assert(trackedSmokeExport?.artifactAvailable === true, 'Completed smoke export artifact should be marked ready.')
  assert(trackedXlsxExport?.artifactAvailable === true, 'Completed XLSX smoke export artifact should be marked ready.')
  assert(
    trackedSmokeExport?.output?.artifact?.renderer === 'pdf-lib-acroform',
    'PDF smoke export should fill the uploaded template.'
  )
  assert(
    trackedXlsxExport?.output?.artifact?.renderer === 'structured-xlsx',
    'XLSX smoke export should use structured workbook renderer.'
  )
  const completedDownloadTarget = exportsList.find(
    (entry) => entry.id === trackedSmokeExport.id && entry.status === 'completed'
  )
  assert(Boolean(completedDownloadTarget), 'Completed smoke export should be available in export listing.')
  currentStep = 'download completed PDF artifact'
  logSuiteStep('smoke', currentStep, { exportId: completedDownloadTarget.id })
  const download = await context.rawRequest(`/api/exports/${completedDownloadTarget.id}/download`, {
    headers: { Cookie: context.sessionCookie }
  })
  assert(download.status === 200, 'Completed smoke export should be downloadable.')
  const downloadType = download.headers.get('content-type') || ''
  assert(downloadType === 'application/pdf', 'Completed smoke export download should return PDF content type.')
  currentStep = 'download completed XLSX artifact'
  logSuiteStep('smoke', currentStep, { exportId: trackedXlsxExport.id })
  const xlsxDownload = await context.rawRequest(`/api/exports/${trackedXlsxExport.id}/download`, {
    headers: { Cookie: context.sessionCookie }
  })
  assert(xlsxDownload.status === 200, 'Completed XLSX smoke export should be downloadable.')
  const xlsxDownloadType = xlsxDownload.headers.get('content-type') || ''
  assert(
    xlsxDownloadType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Completed XLSX smoke export download should return workbook content type.'
  )
  await xlsxDownload.arrayBuffer()

  const summary = {
    ok: true,
    profileId: profile.id,
    templateId: template.id,
    linkedFormTemplateId: template.linkedFormTemplateId,
    exportJobId: trackedSmokeExport?.id || exportJob.id,
    exportStatus: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))?.status,
    exportArtifactReady: exportsList.find((entry) => entry.id === (trackedSmokeExport?.id || exportJob.id))
      ?.artifactAvailable,
    xlsxJobId: trackedXlsxExport?.id || xlsxJob.id,
    xlsxStatus: trackedXlsxExport?.status,
    flakyJobId: flakyJob.id,
    flakyStatus: exportsList.find((entry) => entry.id === flakyJob.id)?.status,
    queuePending: queueHealth?.queue?.pending,
    queueStalled: queueHealth?.queue?.stalled
  }

  evidence.finalize({ status: 'passed', details: summary })
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  const diagnostics = await captureExportDiagnostics({
    suite: 'smoke',
    currentStep,
    context,
    headers: context?.authHeaders?.()
  })
  const wrappedError = new Error(
    `[smoke] step="${currentStep}" failed: ${error?.message || String(error)}\n${JSON.stringify(diagnostics, null, 2)}`
  )
  evidence.finalize({ status: 'failed', error: wrappedError, details: diagnostics })
  process.exitCode = 1
  throw wrappedError
} finally {
  await context?.shutdown?.()
}
