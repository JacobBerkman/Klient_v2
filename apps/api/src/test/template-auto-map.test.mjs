import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import {
  suggestMapping,
  suggestSourcePath,
  suggestSourcePaths,
  defaultSourcePathForField
} from '../modules/templates/auto-map.mjs'
import { createTemplatesService } from '../modules/templates/service.mjs'

const repoRoot = process.cwd()

async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-auto-map-'))
  process.chdir(tempDir)
  process.env.NODE_ENV = 'test'
  process.env.APP_SECRET = 'template-auto-map-secret-abcdefghijklmnopqrstuvwxyz'
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const { createStore } = await import(moduleUrl)
  const store = createStore()
  process.chdir(previousCwd)
  return store
}

function createAdvisor(store, firmName = 'Auto Map Advisory') {
  const session = store.register({
    firmName,
    firstName: 'Avery',
    lastName: 'Mapper',
    email: `auto-map-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'AutoMapPass123!'
  })
  return store.requireUser(session.token)
}

async function createHeuristicPdf() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  form.createTextField('client_first_name').addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField('spouse_dob').addToPage(page, { x: 72, y: 660, width: 240, height: 24 })
  form.createTextField('household_name').addToPage(page, { x: 72, y: 620, width: 240, height: 24 })
  form.createTextField('other_notes').addToPage(page, { x: 72, y: 580, width: 240, height: 24 })
  const consent = form.createCheckBox('consent_checkbox')
  consent.addToPage(page, { x: 72, y: 540, width: 18, height: 18 })
  return Buffer.from(await pdf.save())
}

test('suggestSourcePath heuristics map confident field names and reject ambiguous ones', () => {
  assert.equal(suggestSourcePath('client_first_name'), 'profile.firstName')
  assert.equal(suggestSourcePath('applicant_email'), 'profile.email')
  assert.equal(suggestSourcePath('primary_phone'), 'profile.phone')
  assert.equal(suggestSourcePath('First Name'), 'profile.firstName')
  assert.equal(suggestSourcePath('dob'), 'profile.dateOfBirth')
  assert.equal(suggestSourcePath('surname'), 'profile.lastName')

  assert.equal(suggestSourcePath('spouse_dob'), 'spouse.dateOfBirth')
  assert.equal(suggestSourcePath('spouse_first_name'), 'spouse.firstName')
  assert.equal(suggestSourcePath('partner_email'), 'spouse.email')
  assert.equal(suggestSourcePath('coapplicant_last_name'), 'spouse.lastName')

  assert.equal(suggestSourcePath('household_name'), 'household.name')
  assert.equal(suggestSourcePath('household'), 'household.name')

  // Conservative: unknown / ambiguous names must return null so auto-build
  // keeps its default form-key behavior.
  assert.equal(suggestSourcePath('zx9_garbage_field_42'), null)
  assert.equal(suggestSourcePath('client_name'), null)
  assert.equal(suggestSourcePath('salary'), null)
  assert.equal(suggestSourcePath('started'), null)
  assert.equal(suggestSourcePath(''), null)
  assert.equal(suggestSourcePath(null), null)

  assert.deepEqual(suggestMapping('spouse_dob'), { sourcePath: 'spouse.dateOfBirth', type: 'date' })
  assert.equal(defaultSourcePathForField('Client First-Name'), 'client_first_name')

  const bulk = suggestSourcePaths(['client_first_name', 'zx9_garbage_field_42', 'household_name'])
  assert.equal(bulk.get('client_first_name'), 'profile.firstName')
  assert.equal(bulk.get('household_name'), 'household.name')
  assert.equal(bulk.has('zx9_garbage_field_42'), false)
})

test('auto-build maps heuristic PDF field names to profile/spouse/household paths', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createHeuristicPdf()

  const template = await store.autoBuildTemplate(user, {
    name: 'Heuristic Intake PDF',
    fileName: 'heuristic-intake.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  assert.equal(template.extraction.status, 'completed')
  const byField = Object.fromEntries(template.mappings.map((mapping) => [mapping.pdfField, mapping]))

  // Auto-build generates the intake form the CLIENT fills, so the generated
  // form key stays the primary source (their answer wins) and the heuristic
  // match rides along as fallbackSourcePath — used by export resolution only
  // when the client left the field blank.
  assert.equal(byField.client_first_name.sourcePath, 'client_first_name')
  assert.equal(byField.client_first_name.fallbackSourcePath, 'profile.firstName')
  assert.equal(byField.spouse_dob.sourcePath, 'spouse_dob')
  assert.equal(byField.spouse_dob.fallbackSourcePath, 'spouse.dateOfBirth')
  assert.equal(byField.household_name.sourcePath, 'household_name')
  assert.equal(byField.household_name.fallbackSourcePath, 'household.name')
  // Non-matching text field gets no fallback at all.
  assert.equal(byField.other_notes.sourcePath, 'other_notes')
  assert.equal(byField.other_notes.fallbackSourcePath, undefined)
  // Checkbox fields never receive heuristic suggestions.
  assert.equal(byField.consent_checkbox.sourcePath, 'consent_checkbox')
  assert.equal(byField.consent_checkbox.fallbackSourcePath, undefined)
  assert.equal(byField.consent_checkbox.transform?.type, 'checkbox')
})

test('auto-map fills the record fallback (never the primary) when an intake form exists', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createHeuristicPdf()

  // Auto-build produces a linked intake form, so every PDF field is something
  // the CLIENT can answer. Auto-map must therefore populate the record fallback
  // and leave the form key as the primary source — overwriting the primary would
  // silently discard the client's answers.
  const template = await store.autoBuildTemplate(user, {
    name: 'Linked Form Auto Map',
    fileName: 'linked-form-auto-map.pdf',
    fileBytesBase64: pdf.toString('base64')
  })
  assert.ok(template.linkedFormTemplateId, 'auto-build generates the linked intake form')

  // Reset the auto-build fallbacks so auto-map has work to do.
  const stripped = template.mappings.map((mapping) => {
    const next = { ...mapping }
    delete next.fallbackSourcePath
    return next
  })
  store.updateTemplateMappings(user, template.id, stripped)

  const result = store.autoMapTemplateMappings(user, template.id)
  assert.ok(result.applied > 0, 'confident matches are applied')
  const byField = Object.fromEntries(result.template.mappings.map((mapping) => [mapping.pdfField, mapping]))

  assert.equal(byField.client_first_name.sourcePath, 'client_first_name', "the client's answer stays primary")
  assert.equal(byField.client_first_name.fallbackSourcePath, 'profile.firstName')
  assert.equal(byField.spouse_dob.sourcePath, 'spouse_dob')
  assert.equal(byField.spouse_dob.fallbackSourcePath, 'spouse.dateOfBirth')
  assert.equal(byField.household_name.fallbackSourcePath, 'household.name')
  // No confident match: no fallback invented.
  assert.equal(byField.other_notes.fallbackSourcePath, undefined)

  // Idempotent.
  const second = store.autoMapTemplateMappings(user, template.id)
  assert.equal(second.applied, 0)
})

test('auto-map action applies suggestions to default rows, is idempotent, and versions the change', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  // No linked intake form: there is no client answer to protect, so suggestions
  // become the PRIMARY source path.
  const template = store.createDocumentTemplate(user, {
    name: 'Manual Auto Map Template',
    mappings: [
      { pdfField: 'client_first_name', sourcePath: 'client_first_name' },
      { pdfField: 'spouse_email', sourcePath: 'spouse_email' },
      { pdfField: 'custom_thing', sourcePath: 'custom_thing' },
      // Already customized by an advisor: auto-map must leave it alone.
      { pdfField: 'client_last_name', sourcePath: 'profile.email' }
    ]
  })
  const versionsBefore = template.versions.length

  const result = store.autoMapTemplateMappings(user, template.id)
  assert.equal(result.total, 4)
  assert.equal(result.applied, 2)
  const byField = Object.fromEntries(result.template.mappings.map((mapping) => [mapping.pdfField, mapping]))
  assert.equal(byField.client_first_name.sourcePath, 'profile.firstName')
  assert.equal(byField.spouse_email.sourcePath, 'spouse.email')
  assert.equal(byField.custom_thing.sourcePath, 'custom_thing')
  assert.equal(byField.client_last_name.sourcePath, 'profile.email')

  // Version snapshot + audit trail consistent with mapping edits.
  assert.equal(result.template.versions.length, versionsBefore + 1)
  const latestVersion = result.template.versions[result.template.versions.length - 1]
  assert.equal(latestVersion.event, 'mappings_updated')
  const audits = store.listAudit(user)
  assert.ok(
    audits.some((entry) => entry.action === 'document_template.mappings_auto_mapped' && entry.entityId === template.id)
  )

  // Idempotent: a second run finds nothing left at the auto-build default.
  const second = store.autoMapTemplateMappings(user, template.id)
  assert.equal(second.applied, 0)
  assert.equal(second.total, 4)
  assert.equal(second.template.versions.length, versionsBefore + 1)
  assert.equal(
    Object.fromEntries(second.template.mappings.map((mapping) => [mapping.pdfField, mapping.sourcePath]))
      .client_first_name,
    'profile.firstName'
  )
})

test('auto-map and mapping-paths are firm scoped', async () => {
  const store = await loadStore()
  const owner = createAdvisor(store, 'Auto Map Owner Firm')
  const outsider = createAdvisor(store, 'Auto Map Outsider Firm')

  const template = store.createDocumentTemplate(owner, {
    name: 'Firm Scoped Template',
    mappings: [{ pdfField: 'client_first_name', sourcePath: 'client_first_name' }]
  })

  assert.throws(() => store.autoMapTemplateMappings(outsider, template.id))
  assert.throws(() => store.getTemplateMappingPaths(outsider, template.id))

  // Owner still succeeds after the denied attempts.
  const result = store.autoMapTemplateMappings(owner, template.id)
  assert.equal(result.applied, 1)
})

test('templates service guards mapping-paths reads and auto-map writes', () => {
  const guardCalls = []
  const repoCalls = []
  const repository = {
    getTemplateMappingPaths: (...args) => {
      repoCalls.push(['getTemplateMappingPaths', ...args])
      return { groups: [] }
    },
    autoMapTemplateMappings: (...args) => {
      repoCalls.push(['autoMapTemplateMappings', ...args])
      return { applied: 0, total: 0, template: { id: 'template-1' } }
    }
  }
  const allowPolicy = { requireGuard: (user, guard) => guardCalls.push(guard) }
  const service = createTemplatesService({ templateRepository: repository, policy: allowPolicy })
  const user = { id: 'u1', firmId: 'f1', role: 'advisor' }

  service.mappingPaths(user, 'template-1')
  service.autoMapMappings(user, 'template-1')
  assert.deepEqual(guardCalls, ['canReadTemplate', 'canEditTemplate'])
  assert.deepEqual(
    repoCalls.map((entry) => entry[0]),
    ['getTemplateMappingPaths', 'autoMapTemplateMappings']
  )

  // Guard denial short-circuits before the repository is reached.
  const denyPolicy = {
    requireGuard: () => {
      const error = new Error('Guard denied.')
      error.statusCode = 403
      throw error
    }
  }
  const deniedService = createTemplatesService({ templateRepository: repository, policy: denyPolicy })
  const callsBefore = repoCalls.length
  assert.throws(() => deniedService.autoMapMappings(user, 'template-1'), /Guard denied/)
  assert.throws(() => deniedService.mappingPaths(user, 'template-1'), /Guard denied/)
  assert.equal(repoCalls.length, callsBefore)
})

test('mapping-paths returns the five contracted groups with spouse/household and no pii paths', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const pdf = await createHeuristicPdf()
  const template = await store.autoBuildTemplate(user, {
    name: 'Mapping Paths PDF',
    fileName: 'mapping-paths.pdf',
    fileBytesBase64: pdf.toString('base64')
  })

  const result = store.getTemplateMappingPaths(user, template.id)
  assert.ok(Array.isArray(result.groups))
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ['profile', 'spouse', 'household', 'custom', 'form']
  )
  for (const group of result.groups) {
    assert.equal(typeof group.label, 'string')
    assert.ok(group.label.length > 0)
    assert.ok(Array.isArray(group.paths))
    for (const entry of group.paths) {
      assert.equal(typeof entry.path, 'string')
      assert.equal(typeof entry.label, 'string')
      assert.equal(typeof entry.type, 'string')
    }
  }

  const groupByKey = Object.fromEntries(result.groups.map((group) => [group.key, group]))
  const spousePaths = groupByKey.spouse.paths.map((entry) => entry.path)
  assert.deepEqual(spousePaths, [
    'spouse.firstName',
    'spouse.lastName',
    'spouse.email',
    'spouse.phone',
    'spouse.dateOfBirth'
  ])
  const householdPaths = groupByKey.household.paths.map((entry) => entry.path)
  assert.ok(householdPaths.includes('household.name'))
  assert.ok(householdPaths.includes('household.primary.firstName'))
  assert.ok(householdPaths.includes('household.primary.dateOfBirth'))
  assert.ok(groupByKey.profile.paths.some((entry) => entry.path === 'profile.firstName'))
  const dateEntry = groupByKey.spouse.paths.find((entry) => entry.path === 'spouse.dateOfBirth')
  assert.equal(dateEntry.type, 'date')

  // Linked-form schema paths surface in the form group.
  assert.ok(groupByKey.form.paths.some((entry) => entry.path === 'client_first_name'))

  // Encrypted PII must never be mapping-exposed.
  const allPaths = result.groups.flatMap((group) => group.paths.map((entry) => entry.path.toLowerCase()))
  assert.ok(allPaths.every((path) => !path.includes('pii') && !path.includes('ssn') && !path.includes('taxid')))
})
