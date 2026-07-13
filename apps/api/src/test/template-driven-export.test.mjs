import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
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

// Minimal ZIP reader for the structured-xlsx artifact: walks local file headers
// (stored with correct sizes by zipEntries) and inflates each deflate-raw entry.
function readZipEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    const compressed = buffer.slice(dataStart, dataStart + compressedSize)
    entries.set(name, inflateRawSync(compressed).toString('utf8'))
    offset = dataStart + compressedSize
  }
  return entries
}

async function createSpouseHouseholdSourcePdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  form.createTextField('client_name').addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField('spouse_first').addToPage(page, { x: 72, y: 660, width: 240, height: 24 })
  form.createTextField('household_name').addToPage(page, { x: 72, y: 620, width: 240, height: 24 })
  return Buffer.from(await pdf.save())
}

test('spouse and household mappings resolve into PDF and XLSX exports', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const sourcePdf = await createSpouseHouseholdSourcePdf()

  const template = await store.autoBuildTemplate(user, {
    name: 'Spouse Household Export',
    fileName: 'spouse-household-export.pdf',
    fileBytesBase64: sourcePdf.toString('base64')
  })
  const byField = Object.fromEntries(template.mappings.map((mapping) => [mapping.pdfField, mapping]))
  assert.equal(byField.spouse_first.sourcePath, 'spouse.firstName')
  assert.equal(byField.household_name.sourcePath, 'household.name')
  assert.equal(byField.client_name.sourcePath, 'client_name')

  const primary = store.createProfile(user, {
    kind: 'client',
    firstName: 'Harper',
    lastName: 'Hartley',
    email: `primary-${Date.now()}@example.test`
  })
  const spouse = store.createProfile(user, {
    kind: 'client',
    firstName: 'Sydney',
    lastName: 'Spouse',
    email: `spouse-${Date.now()}@example.test`
  })
  store.linkSpouse(user, primary.id, spouse.id)

  const submission = store.createFormSubmission(user, {
    clientId: primary.id,
    templateId: template.linkedFormTemplateId,
    status: 'submitted',
    data: { client_name: 'Harper Hartley' }
  })

  const pdfJob = store.createExport(user, {
    templateId: template.id,
    clientId: primary.id,
    submissionId: submission.id,
    type: 'pdf'
  })
  const xlsxJob = store.createExport(user, {
    templateId: template.id,
    clientId: primary.id,
    submissionId: submission.id,
    type: 'xlsx'
  })
  const processed = await store.processQueuedExports(user)
  assert.equal(processed.processed, 2)
  assert.equal(processed.failed, 0)

  const pdfDownload = await store.getExportDownload(user, pdfJob.id)
  const filledPdf = await PDFDocument.load(pdfDownload.body)
  const filledForm = filledPdf.getForm()
  assert.equal(filledForm.getTextField('client_name').getText(), 'Harper Hartley')
  assert.equal(filledForm.getTextField('spouse_first').getText(), 'Sydney')
  assert.equal(filledForm.getTextField('household_name').getText(), 'Hartley Household')

  const xlsxDownload = await store.getExportDownload(user, xlsxJob.id)
  const zipEntries = readZipEntries(xlsxDownload.body)
  const sharedStrings = zipEntries.get('xl/sharedStrings.xml') || ''
  assert.ok(sharedStrings.includes('Sydney'), 'XLSX shared strings should include the spouse first name')
  assert.ok(sharedStrings.includes('Hartley Household'), 'XLSX shared strings should include the household name')
  assert.ok(sharedStrings.includes('spouse.firstName'), 'XLSX shared strings should include the spouse source path')
})

test('exports with spouse/household mappings still complete when no spouse is linked', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const sourcePdf = await createSpouseHouseholdSourcePdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Spouse Missing Export',
    fileName: 'spouse-missing-export.pdf',
    fileBytesBase64: sourcePdf.toString('base64')
  })
  const solo = store.createProfile(user, {
    kind: 'client',
    firstName: 'Solo',
    lastName: 'Client',
    email: `solo-${Date.now()}@example.test`
  })
  const submission = store.createFormSubmission(user, {
    clientId: solo.id,
    templateId: template.linkedFormTemplateId,
    status: 'submitted',
    data: { client_name: 'Solo Client' }
  })

  const job = store.createExport(user, {
    templateId: template.id,
    clientId: solo.id,
    submissionId: submission.id,
    type: 'pdf'
  })
  const processed = await store.processQueuedExports(user)
  assert.equal(processed.processed, 1)
  assert.equal(processed.failed, 0)

  const completed = store.listExports(user).find((entry) => entry.id === job.id)
  assert.equal(completed.status, 'completed')
  const diagnostics = completed.output?.artifact?.diagnostics || []
  const skipped = diagnostics.filter((entry) => entry.code === 'PDF_FIELD_SKIPPED_EMPTY')
  assert.ok(
    skipped.some((entry) => entry.details?.pdfField === 'spouse_first'),
    'missing spouse should surface a skipped-empty diagnostic for the spouse field'
  )
  assert.ok(
    skipped.some((entry) => entry.details?.pdfField === 'household_name'),
    'missing household should surface a skipped-empty diagnostic for the household field'
  )

  const download = await store.getExportDownload(user, job.id)
  const filledPdf = await PDFDocument.load(download.body)
  const filledForm = filledPdf.getForm()
  assert.equal(filledForm.getTextField('client_name').getText(), 'Solo Client')
  assert.equal(filledForm.getTextField('spouse_first').getText() ?? '', '')
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
