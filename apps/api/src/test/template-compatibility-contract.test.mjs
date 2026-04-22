import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTemplateWorkflowPdf } from '../../../../scripts/pdf-fixtures.mjs'

const repoRoot = process.cwd()

async function loadRuntime() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-compat-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-compat-secret-abcdefghijklmnopqrstuvwxyz'
  const suffix = `?t=${Date.now()}-${Math.random()}`
  const storeModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + suffix)
  const modulesModule = await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/modules/index.mjs')).href + suffix)
  const store = storeModule.createStore()
  const modules = modulesModule.createModules({ store, reads: {} })
  process.chdir(previousCwd)
  return { store, modules }
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Compatibility Advisory',
    firstName: 'Casey',
    lastName: 'Compat',
    email: `compat-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'CompatPass123!'
  })
  return store.requireUser(session.token)
}

test('compatibility template surfaces preserve generated form and source-backed document metadata', async () => {
  const { store, modules } = await loadRuntime()
  const user = createAdvisor(store)
  const pdf = await createTemplateWorkflowPdf()

  const autoBuilt = await modules.templates.autoBuild(user, {
    name: 'Compatibility PDF Intake',
    fileName: 'compatibility-intake.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  const documents = modules.templates.list(user)
  const documentFromCompatibility = documents.find((entry) => entry.id === autoBuilt.id)
  assert.ok(documentFromCompatibility, 'document template should be readable from /api/templates compatibility list')
  assert.equal(documentFromCompatibility.extraction?.status, 'completed')
  assert.equal(documentFromCompatibility.linkedFormTemplateId, autoBuilt.linkedFormTemplateId)
  assert.equal(documentFromCompatibility.sourceArtifact?.key, autoBuilt.sourceArtifact.key)
  assert.equal(documentFromCompatibility.sourceArtifact?.checksum, autoBuilt.sourceArtifact.checksum)
  assert.equal(documentFromCompatibility.exportReadiness?.status, 'ready')
  assert.ok(Array.isArray(documentFromCompatibility.extractedFields))
  assert.ok(documentFromCompatibility.extractedFields.length >= 1)
  assert.ok(documentFromCompatibility.pdfLayout?.fields?.length >= 1)

  const forms = modules.forms.listFormTemplates(user)
  const linkedForm = forms.find((entry) => entry.id === autoBuilt.linkedFormTemplateId)
  assert.ok(linkedForm, 'linked generated form should be readable from /api/forms/templates compatibility list')
  assert.equal(linkedForm.generatedFromDocumentTemplateId, autoBuilt.id)
  assert.equal(linkedForm.generation?.source, 'pdf_acroform')
  assert.equal(linkedForm.generation?.fieldCount, autoBuilt.autoBuildSummary.fieldCount)
  assert.equal(linkedForm.generation?.repeatableSectionCount, autoBuilt.autoBuildSummary.repeatableSectionCount)
  assert.ok(Array.isArray(linkedForm.formSchema?.sections))
  assert.deepEqual(linkedForm.sections, linkedForm.formSchema.sections)
})
