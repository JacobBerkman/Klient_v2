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
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-portal-prefill-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'portal-prefill-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store, firmName = 'Prefill Advisory') {
  const session = store.register({
    firmName,
    firstName: 'Piper',
    lastName: 'Prefill',
    email: `prefill-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'PrefillPass123!'
  })
  return store.requireUser(session.token)
}

async function createIntakePdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  form.createTextField('client_first_name').addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField('client_email').addToPage(page, { x: 72, y: 660, width: 240, height: 24 })
  form.createTextField('spouse_first_name').addToPage(page, { x: 72, y: 620, width: 240, height: 24 })
  form.createTextField('household_name').addToPage(page, { x: 72, y: 580, width: 240, height: 24 })
  form.createTextField('other_notes').addToPage(page, { x: 72, y: 540, width: 240, height: 24 })
  return Buffer.from(await pdf.save())
}

async function seedHouseholdWithIntakeTemplate(store, user) {
  const template = await store.autoBuildTemplate(user, {
    name: 'Household Intake',
    fileName: 'household-intake.pdf',
    fileBytesBase64: (await createIntakePdf()).toString('base64')
  })

  const primary = store.createProfile(user, {
    kind: 'client',
    firstName: 'Harper',
    lastName: 'Hartley',
    email: 'harper@hartley.example'
  })
  const spouse = store.createProfile(user, {
    kind: 'client',
    firstName: 'Sydney',
    lastName: 'Hartley',
    email: 'sydney@hartley.example'
  })
  store.linkSpouse(user, primary.id, spouse.id)

  return { template, primary, spouse }
}

test('the intake form opens pre-filled from the client record, spouse, and household', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const { template, primary } = await seedHouseholdWithIntakeTemplate(store, user)

  const link = store.createPortalLink(user, primary.id, { maxUses: 5 })
  const portal = store.getPortalData(link.token)

  const intakeForm = portal.availableTemplates.find((entry) => entry.id === template.linkedFormTemplateId)
  assert.ok(intakeForm, 'the generated intake form is offered in the portal')

  // Records the firm already holds are seeded onto the exact form field keys the
  // PDF mapping reads, so the client confirms rather than retypes them.
  assert.equal(intakeForm.prefill.client_first_name, 'Harper')
  assert.equal(intakeForm.prefill.client_email, 'harper@hartley.example')
  assert.equal(intakeForm.prefill.spouse_first_name, 'Sydney')
  assert.equal(intakeForm.prefill.household_name, 'Hartley Household')

  // Fields with no confident record match are never invented.
  assert.equal(Object.hasOwn(intakeForm.prefill, 'other_notes'), false)
})

test("a client's correction to a pre-filled value reaches the exported PDF", async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const { template, primary } = await seedHouseholdWithIntakeTemplate(store, user)

  const link = store.createPortalLink(user, primary.id, { maxUses: 5 })
  const portal = store.getPortalData(link.token)
  const intakeForm = portal.availableTemplates.find((entry) => entry.id === template.linkedFormTemplateId)

  // The client submits the pre-filled form, correcting a stale email. Everything
  // they leave untouched is submitted as their own answer.
  const submission = store.portalSubmit(link.token, {
    templateId: intakeForm.id,
    status: 'submitted',
    data: { ...intakeForm.prefill, client_email: 'harper.new@hartley.example' }
  })
  assert.equal(submission.status, 'submitted')

  const job = store.createExport(user, {
    templateId: template.id,
    clientId: primary.id,
    submissionId: submission.id,
    type: 'pdf'
  })
  const processed = await store.processQueuedExports(user)
  assert.equal(processed.failed, 0)

  const download = await store.getExportDownload(user, job.id)
  const filled = (await PDFDocument.load(download.body)).getForm()

  // The correction wins over the stale profile record...
  assert.equal(filled.getTextField('client_email').getText(), 'harper.new@hartley.example')
  // ...and the values they confirmed still land in the document.
  assert.equal(filled.getTextField('client_first_name').getText(), 'Harper')
  assert.equal(filled.getTextField('spouse_first_name').getText(), 'Sydney')
  assert.equal(filled.getTextField('household_name').getText(), 'Hartley Household')
})

test('prefill is firm-scoped and empty without a linked document template', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  // A hand-authored form template has no document template behind it, so there
  // is no mapping vocabulary to seed from.
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Nora',
    lastName: 'Nolink',
    email: 'nora@nolink.example'
  })
  const standalone = store.createFormTemplate(user, {
    name: 'Standalone Questionnaire',
    sections: [{ title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] }]
  })

  const link = store.createPortalLink(user, profile.id, { maxUses: 2 })
  const portal = store.getPortalData(link.token)
  const form = portal.availableTemplates.find((entry) => entry.id === standalone.id)
  assert.deepEqual(form.prefill, {})
})
