import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const repoRoot = process.cwd()

async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-export-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-export-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Template Export Advisory',
    firstName: 'Elliot',
    lastName: 'Exporter',
    email: `template-export-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'TemplateExport123!'
  })
  return store.requireUser(session.token)
}

async function createSourcePdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()

  const clientName = form.createTextField('client_name')
  clientName.addToPage(page, { x: 72, y: 700, width: 240, height: 24 })

  const consent = form.createCheckBox('consent_checkbox')
  consent.addToPage(page, { x: 72, y: 660, width: 18, height: 18 })

  return Buffer.from(await pdf.save())
}

async function createTemplatePipeline(store, user) {
  const sourcePdf = await createSourcePdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Template Driven Export',
    fileName: 'template-driven-export.pdf',
    fileBytesBase64: sourcePdf.toString('base64')
  })
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Morgan',
    lastName: 'Artifact',
    email: `artifact-${Date.now()}@example.test`
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: template.linkedFormTemplateId,
    status: 'submitted',
    data: {
      client_name: 'Morgan Artifact',
      consent_checkbox: true
    }
  })
  return { template, profile, submission }
}

test('template-driven PDF and XLSX exports persist completed artifacts and download from object storage', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const { template, profile, submission } = await createTemplatePipeline(store, user)

  const pdfJob = store.createExport(user, {
    templateId: template.id,
    clientId: profile.id,
    submissionId: submission.id,
    type: 'pdf'
  })
  const xlsxJob = store.createExport(user, {
    templateId: template.id,
    clientId: profile.id,
    submissionId: submission.id,
    type: 'xlsx'
  })

  const processed = await store.processQueuedExports(user)
  assert.equal(processed.processed, 2)
  assert.equal(processed.failed, 0)

  const jobs = store.listExports(user)
  // Exports list is clamped: an explicit limit is honored and oversized or
  // invalid limits fall back to the ≤200 cap instead of unbounded rows.
  assert.equal(store.listExports(user, { limit: 1 }).length, 1, 'exports list honors the clamped limit parameter')
  assert.equal(store.listExports(user, { limit: 9_999 }).length, jobs.length, 'oversized limit is clamped')
  const completedPdf = jobs.find((job) => job.id === pdfJob.id)
  const completedXlsx = jobs.find((job) => job.id === xlsxJob.id)
  assert.equal(completedPdf.status, 'completed')
  assert.equal(completedPdf.artifactReady, true)
  assert.equal(completedPdf.output?.artifact?.renderer, 'pdf-lib-acroform')
  assert.equal(completedPdf.output?.artifact?.fallbackReason, null)
  assert.equal(completedPdf.output?.artifact?.sourceArtifactChecksum, template.sourceArtifact.checksum)
  assert.ok(completedPdf.output?.object?.key)
  assert.equal(completedPdf.output?.object?.contentType, 'application/pdf')

  assert.equal(completedXlsx.status, 'completed')
  assert.equal(completedXlsx.artifactReady, true)
  assert.equal(completedXlsx.output?.artifact?.renderer, 'structured-xlsx')
  assert.equal(
    completedXlsx.output?.object?.contentType,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )

  const pdfDownload = await store.getExportDownload(user, pdfJob.id)
  assert.equal(pdfDownload.contentType, 'application/pdf')
  assert.ok(pdfDownload.body.length > 100)
  const filledPdf = await PDFDocument.load(pdfDownload.body)
  const filledForm = filledPdf.getForm()
  assert.equal(filledForm.getTextField('client_name').getText(), 'Morgan Artifact')
  assert.equal(filledForm.getCheckBox('consent_checkbox').isChecked(), true)

  const xlsxDownload = await store.getExportDownload(user, xlsxJob.id)
  assert.equal(xlsxDownload.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(xlsxDownload.body.slice(0, 2).toString('utf8'), 'PK')
  assert.ok(xlsxDownload.body.length > 1000)
})

test('manual document templates keep explicit summary PDF fallback metadata', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const template = store.createDocumentTemplate(user, {
    name: 'Manual Summary Template',
    mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }],
    exportReadiness: {
      status: 'summary_fallback',
      reason: 'missing_source_artifact',
      message: 'Manual template has no uploaded PDF source.'
    }
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Fallback', lastName: 'Client' })
  const job = store.createExport(user, { templateId: template.id, clientId: profile.id, type: 'pdf' })

  const processed = await store.processQueuedExports(user)
  assert.equal(processed.processed, 1)
  const completed = store.listExports(user).find((entry) => entry.id === job.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.output?.artifact?.renderer, 'summary-pdf')
  assert.equal(completed.output?.artifact?.fallbackReason, 'missing_source_artifact')
})
