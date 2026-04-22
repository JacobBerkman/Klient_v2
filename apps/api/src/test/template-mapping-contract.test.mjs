import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeMappingsByPdfField } from '../../../../scripts/mapping-fixtures.mjs'
import { createTemplateWorkflowPdf } from '../../../../scripts/pdf-fixtures.mjs'

const repoRoot = process.cwd()

async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-mapping-contract-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-mapping-contract-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Mapping Contract Advisory',
    firstName: 'Morgan',
    lastName: 'Mapper',
    email: `mapping-contract-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'MappingContract123!'
  })
  return store.requireUser(session.token)
}

test('auto-built PDF templates require complete mapping updates by default', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createTemplateWorkflowPdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Mapping Contract PDF',
    fileName: 'mapping-contract.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'completed')
  assert.equal(template.mappings.length, template.extractedFields.length)
  assert.ok(template.mappings.some((mapping) => mapping.repeaterPath === 'dependents'))

  const unchanged = store.updateTemplateMappings(user, template.id, template.mappings)
  assert.equal(unchanged.mappings.length, template.extractedFields.length)

  assert.throws(
    () => {
      store.updateTemplateMappings(user, template.id, template.mappings.slice(0, 2))
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.equal(error.statusCode, 400)
      const missingIssues = error.details?.issues?.filter((issue) => issue.code === 'required_pdf_field_missing') || []
      assert.ok(missingIssues.length >= 1)
      assert.ok(missingIssues.some((issue) => issue.meta?.requiredPdfField === 'started'))
      assert.ok(missingIssues.some((issue) => issue.meta?.requiredPdfField === 'dependents_1_name'))
      return true
    }
  )
})

test('merged mapping overrides preserve generated required fields and repeater paths', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createTemplateWorkflowPdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Merged Mapping Contract PDF',
    fileName: 'merged-mapping-contract.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  const merged = mergeMappingsByPdfField(template.mappings, [
    { pdfField: 'client_name', sourcePath: 'client_name' },
    { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } },
    { pdfField: 'started', sourcePath: 'started', transform: { type: 'date' } },
    { pdfField: 'retired', sourcePath: 'retired', transform: { type: 'checkbox' } },
    { pdfField: 'missing_with_default', sourcePath: 'missing.path', defaultValue: 'N/A' }
  ])

  const updated = store.updateTemplateMappings(user, template.id, merged)
  const byField = Object.fromEntries(updated.mappings.map((mapping) => [mapping.pdfField, mapping]))

  assert.equal(updated.mappings.length, template.extractedFields.length)
  assert.equal(byField.salary.transform.type, 'currency')
  assert.equal(byField.started.transform.type, 'date')
  assert.equal(byField.retired.transform.type, 'checkbox')
  assert.equal(byField.missing_with_default.defaultValue, 'N/A')
  assert.equal(byField.dependents_1_name.sourcePath, 'dependents.0.name')
  assert.equal(byField.dependents_1_name.repeaterPath, 'dependents')
  assert.equal(byField.dependents_2_name.sourcePath, 'dependents.1.name')
  assert.equal(byField.dependents_2_name.repeaterPath, 'dependents')
})
