import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/template-ingestion')

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-ingestion-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-template-ingestion'
    const moduleUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Template Ingestion Firm',
    firstName: 'Taylor',
    lastName: 'Extractor',
    email: `ingestion-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'TemplateIngest123!'
  })
  return store.requireUser(session.token)
}

test('autoBuildTemplate extracts AcroForm metadata and snapshots it in versions', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = readFileSync(join(fixtureDir, 'acroform-mixed.pdf'))

  const template = store.autoBuildTemplate(user, {
    name: 'Extracted Template',
    fileName: 'acroform-mixed.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'completed')
  assert.equal(template.extraction.reasonCode, null)
  assert.equal(template.extraction.error, null)
  assert.deepEqual(template.extraction.diagnostics, [])
  assert.equal(template.extractedFields.length, 4)
  assert.equal(template.mappings.length, 3)

  const textField = template.extractedFields.find((entry) => entry.fieldName === 'client_name')
  assert.deepEqual(textField, {
    fieldName: 'client_name',
    fieldType: 'text',
    pageIndex: 0,
    required: true,
    readOnly: false
  })

  const checkboxField = template.extractedFields.find((entry) => entry.fieldName === 'consent_checkbox')
  assert.equal(checkboxField.fieldType, 'checkbox')
  assert.equal(checkboxField.readOnly, true)

  const radioFields = template.extractedFields.filter((entry) => entry.fieldName === 'contact_method')
  assert.equal(radioFields.length, 2)
  assert(radioFields.every((entry) => entry.fieldType === 'radio'))
  assert(radioFields.every((entry) => entry.pageIndex === 1))

  const initialVersion = template.versions.find((entry) => entry.version === 1)
  assert.equal(initialVersion.extraction.status, 'completed')
  assert.equal(initialVersion.extractedFields.length, 4)
})

test('autoBuildTemplate returns failed extraction status for non-form pdf', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = readFileSync(join(fixtureDir, 'non-form.pdf'))

  const template = store.autoBuildTemplate(user, {
    name: 'No Form Template',
    fileName: 'non-form.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'failed')
  assert.equal(template.extraction.reasonCode, 'no_acroform')
  assert.equal(template.extraction.error.code, 'TEMPLATE_INGESTION_NO_ACROFORM')
  assert.match(template.extraction.error.message, /AcroForm/i)
  assert.equal(template.extraction.diagnostics[0]?.reasonCode, 'no_acroform')
  assert.equal(template.extraction.diagnostics[0]?.severity, 'error')
  assert.equal(template.extractedFields.length, 0)
  assert.equal(template.mappings.length, 0)
})

test('autoBuildTemplate returns failed extraction status for malformed files', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = readFileSync(join(fixtureDir, 'malformed.pdf'))

  const template = store.autoBuildTemplate(user, {
    name: 'Malformed Template',
    fileName: 'malformed.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'failed')
  assert.equal(template.extraction.reasonCode, 'malformed_pdf')
  assert.equal(template.extraction.error.code, 'TEMPLATE_INGESTION_MALFORMED_PDF')
  assert.match(template.extraction.error.message, /valid AcroForm PDF/i)
  assert.equal(template.extraction.diagnostics[0]?.reasonCode, 'malformed_pdf')
  assert.equal(template.extractedFields.length, 0)
})

test('autoBuildTemplate returns failed extraction status for AcroForm PDFs with no fields', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const noFieldsPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /AcroForm 2 0 R >>\nendobj\n2 0 obj\n<< /Fields [] >>\nendobj\n%%EOF',
    'latin1'
  )

  const template = store.autoBuildTemplate(user, {
    name: 'No Fields Template',
    fileName: 'no-fields.pdf',
    fileBytesBase64: noFieldsPdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'failed')
  assert.equal(template.extraction.reasonCode, 'no_fields')
  assert.equal(template.extraction.error.code, 'TEMPLATE_INGESTION_NO_FIELDS')
  assert.equal(template.extraction.diagnostics[0]?.code, 'TEMPLATE_INGESTION_NO_FIELDS')
  assert.equal(template.extractedFields.length, 0)
  assert.equal(template.mappings.length, 0)
})
