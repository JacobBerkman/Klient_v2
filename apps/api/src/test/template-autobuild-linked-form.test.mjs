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
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-autobuild-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-autobuild-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Auto Build Advisory',
    firstName: 'Avery',
    lastName: 'Builder',
    email: `auto-build-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'AutoBuildPass123!'
  })
  return store.requireUser(session.token)
}

async function createAcroFormPdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()

  const clientName = form.createTextField('client_name')
  clientName.addToPage(page, { x: 72, y: 700, width: 240, height: 24 })

  const consent = form.createCheckBox('consent_checkbox')
  consent.addToPage(page, { x: 72, y: 660, width: 18, height: 18 })

  const dependentOne = form.createTextField('dependents_1_name')
  dependentOne.addToPage(page, { x: 72, y: 620, width: 240, height: 24 })

  const dependentTwo = form.createTextField('dependents_2_name')
  dependentTwo.addToPage(page, { x: 72, y: 580, width: 240, height: 24 })

  return Buffer.from(await pdf.save())
}

test('PDF auto-build persists source artifact and creates linked generated form template', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createAcroFormPdf()

  const documentTemplate = await store.autoBuildTemplate(user, {
    name: 'Household Intake PDF',
    fileName: 'household-intake.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(documentTemplate.extraction.status, 'completed')
  assert.equal(documentTemplate.extractedFields.length, 4)
  assert.equal(documentTemplate.sourceArtifact?.contentType, 'application/pdf')
  assert.ok(documentTemplate.sourceArtifact?.key)
  assert.ok(documentTemplate.sourceArtifact?.checksum)
  assert.ok(documentTemplate.linkedFormTemplateId)
  assert.equal(documentTemplate.autoBuildSummary?.fieldCount, 4)
  assert.equal(documentTemplate.autoBuildSummary?.repeatableSectionCount, 1)
  assert.equal(documentTemplate.exportReadiness?.status, 'ready')

  const linkedForm = store.listFormTemplates(user).find((entry) => entry.id === documentTemplate.linkedFormTemplateId)
  assert.ok(linkedForm, 'linked generated form template should be readable from forms')
  assert.equal(linkedForm.generatedFromDocumentTemplateId, documentTemplate.id)
  assert.equal(linkedForm.generation?.source, 'pdf_acroform')
  assert.equal(linkedForm.generation?.fieldCount, 4)
  assert.equal(linkedForm.generation?.repeatableSectionCount, 1)

  const repeatableSection = linkedForm.sections.find((section) => section.key === 'dependents')
  assert.ok(repeatableSection?.repeatable, 'indexed dependent fields should become a repeatable section')
  assert.deepEqual(
    repeatableSection.fields.map((field) => field.key),
    ['name']
  )

  const mappingByField = Object.fromEntries(documentTemplate.mappings.map((mapping) => [mapping.pdfField, mapping]))
  assert.equal(mappingByField.client_name.sourcePath, 'client_name')
  assert.equal(mappingByField.consent_checkbox.targetType, 'checkbox')
  assert.equal(mappingByField.dependents_1_name.sourcePath, 'dependents.0.name')
  assert.equal(mappingByField.dependents_1_name.repeaterPath, 'dependents')
  assert.equal(mappingByField.dependents_2_name.sourcePath, 'dependents.1.name')

  const sourceDownload = await store.getTemplateSourcePdf(user, documentTemplate.id)
  assert.equal(sourceDownload.contentType, 'application/pdf')
  assert.ok(sourceDownload.body.length > 100)

  const updatedLayout = store.updateTemplatePdfLayout(user, documentTemplate.id, {
    fields: [{ fieldName: 'client_name', pageIndex: 0, x: 100, y: 650, width: 220, height: 24, locked: true }]
  })
  assert.equal(updatedLayout.pdfLayout.fields[0].fieldName, 'client_name')
  assert.equal(updatedLayout.pdfLayout.fields[0].locked, true)
  assert.ok(updatedLayout.versions.some((entry) => entry.event === 'pdf_layout_updated'))
})

test('PDF auto-build does not create linked form or mappings when extraction fails', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const documentTemplate = await store.autoBuildTemplate(user, {
    name: 'Broken Upload',
    fileName: 'broken.pdf',
    fileBytesBase64: Buffer.from('not a real pdf').toString('base64')
  })

  assert.equal(documentTemplate.extraction.status, 'failed')
  assert.equal(documentTemplate.extraction.reasonCode, 'malformed_pdf')
  assert.equal(documentTemplate.mappings.length, 0)
  assert.equal(documentTemplate.linkedFormTemplateId, null)
  assert.equal(documentTemplate.exportReadiness?.status, 'blocked')
  assert.ok(documentTemplate.extraction.diagnostics?.some((entry) => entry.code === 'TEMPLATE_INGESTION_MALFORMED_PDF'))
})
