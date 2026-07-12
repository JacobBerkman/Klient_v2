import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  VISIBLE_IF_OPS,
  collectMissingRequiredFields,
  evaluateCondition,
  fieldKey,
  isEmptyValue,
  isFieldVisible
} from '../form-conditions.mjs'

process.env.APP_SECRET = 'test-secret-form-conditions'
process.env.AUTH_PROVIDER = 'local'

const repoRoot = process.cwd()

// --- Pure evaluation semantics ---------------------------------------------

test('supported operators are exactly the v1 set', () => {
  assert.deepEqual([...VISIBLE_IF_OPS], ['equals', 'notEquals', 'in', 'notEmpty'])
})

test('fields without visibleIf are always visible', () => {
  assert.equal(isFieldVisible({ key: 'a' }, {}), true)
  assert.equal(isFieldVisible({ key: 'a', visibleIf: null }, {}), true)
})

test('equals / notEquals compare stringwise', () => {
  assert.equal(evaluateCondition({ field: 'q', op: 'equals', value: 'yes' }, { q: 'yes' }), true)
  assert.equal(evaluateCondition({ field: 'q', op: 'equals', value: 'yes' }, { q: 'no' }), false)
  // Number vs string coercion.
  assert.equal(evaluateCondition({ field: 'q', op: 'equals', value: '3' }, { q: 3 }), true)
  assert.equal(evaluateCondition({ field: 'q', op: 'notEquals', value: 'yes' }, { q: 'no' }), true)
  assert.equal(evaluateCondition({ field: 'q', op: 'notEquals', value: 'yes' }, { q: 'yes' }), false)
})

test('in matches when the actual value is a member of the value array', () => {
  assert.equal(evaluateCondition({ field: 'q', op: 'in', value: ['a', 'b'] }, { q: 'b' }), true)
  assert.equal(evaluateCondition({ field: 'q', op: 'in', value: ['a', 'b'] }, { q: 'c' }), false)
  assert.equal(evaluateCondition({ field: 'q', op: 'in', value: 'a' }, { q: 'a' }), false)
})

test('notEmpty is true only for present, non-blank values', () => {
  assert.equal(evaluateCondition({ field: 'q', op: 'notEmpty' }, { q: 'x' }), true)
  assert.equal(evaluateCondition({ field: 'q', op: 'notEmpty' }, { q: '' }), false)
  assert.equal(evaluateCondition({ field: 'q', op: 'notEmpty' }, { q: '   ' }), false)
  assert.equal(evaluateCondition({ field: 'q', op: 'notEmpty' }, {}), false)
})

test('unknown operator fails open (renders the field)', () => {
  assert.equal(evaluateCondition({ field: 'q', op: 'bogus', value: 'x' }, { q: 'y' }), true)
})

test('isEmptyValue treats blanks/empty arrays as empty and booleans as present', () => {
  assert.equal(isEmptyValue(undefined), true)
  assert.equal(isEmptyValue(null), true)
  assert.equal(isEmptyValue(''), true)
  assert.equal(isEmptyValue('  '), true)
  assert.equal(isEmptyValue([]), true)
  assert.equal(isEmptyValue('x'), false)
  assert.equal(isEmptyValue(false), false)
  assert.equal(isEmptyValue(0), false)
})

test('fieldKey resolves key with path/name/id fallbacks', () => {
  assert.equal(fieldKey({ key: 'k' }), 'k')
  assert.equal(fieldKey({ path: 'p' }), 'p')
  assert.equal(fieldKey({ name: 'n' }), 'n')
  assert.equal(fieldKey({ id: 'i' }), 'i')
})

// --- collectMissingRequiredFields (visibleIf-aware required checks) ---------

const conditionalSections = [
  {
    key: 'household',
    title: 'Household',
    fields: [
      { key: 'hasSpouse', label: 'Has spouse', type: 'select', options: ['yes', 'no'] },
      {
        key: 'spouseName',
        label: 'Spouse name',
        type: 'text',
        required: true,
        visibleIf: { field: 'hasSpouse', op: 'equals', value: 'yes' }
      }
    ]
  }
]

test('required hidden field is not reported missing', () => {
  const missing = collectMissingRequiredFields(conditionalSections, { hasSpouse: 'no' })
  assert.deepEqual(missing, [])
})

test('required visible field that is empty is reported missing', () => {
  const missing = collectMissingRequiredFields(conditionalSections, { hasSpouse: 'yes' })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].fieldKey, 'spouseName')
  assert.equal(missing[0].sectionKey, 'household')
})

test('required visible field that is filled is satisfied', () => {
  const missing = collectMissingRequiredFields(conditionalSections, { hasSpouse: 'yes', spouseName: 'Sam' })
  assert.deepEqual(missing, [])
})

test('repeatable sections evaluate required visibleIf per row', () => {
  const sections = [
    {
      key: 'assets',
      title: 'Assets',
      repeatable: true,
      fields: [
        { key: 'kind', label: 'Kind', type: 'select', options: ['cash', 'property'] },
        {
          key: 'address',
          label: 'Address',
          type: 'text',
          required: true,
          visibleIf: { field: 'kind', op: 'equals', value: 'property' }
        }
      ]
    }
  ]
  // Row 0 hides address (cash), row 1 shows+requires it and it is empty.
  const missing = collectMissingRequiredFields(sections, {
    assets: [{ kind: 'cash' }, { kind: 'property' }]
  })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].sectionKey, 'assets')
  assert.equal(missing[0].fieldKey, 'address')
  assert.equal(missing[0].rowIndex, 1)
})

test('repeatable detection covers all three authoring shapes (repeatable / repeater / type:repeater)', () => {
  // The server treats { type: 'repeater' } and { repeater: true } as repeatable
  // just like { repeatable: true }. A missing required row field must be reported
  // for each shape (regression: the client renderers previously gated only on
  // section.repeatable and rendered type:'repeater' flat, silently skipping
  // per-row required validation).
  for (const shape of [{ repeatable: true }, { repeater: true }, { type: 'repeater' }]) {
    const sections = [
      {
        key: 'assets',
        title: 'Assets',
        ...shape,
        fields: [{ key: 'amount', label: 'Amount', type: 'number', required: true }]
      }
    ]
    const missing = collectMissingRequiredFields(sections, { assets: [{ amount: '' }] })
    assert.equal(missing.length, 1, `shape ${JSON.stringify(shape)} is treated as repeatable`)
    assert.equal(missing[0].sectionKey, 'assets')
    assert.equal(missing[0].fieldKey, 'amount')
    assert.equal(missing[0].rowIndex, 0)
  }
})

// --- Server submit validation through the store ----------------------------

async function loadStore() {
  const previousCwd = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-form-conditions-'))
  process.chdir(tempDir)
  try {
    await import(pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href)
    const storeModule = await import(
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    )
    return storeModule.createStore()
  } finally {
    process.chdir(previousCwd)
  }
}

function registerFirm(store, label) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const registered = store.register({
    firmName: `${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label.toLowerCase()}.${suffix}@example.com`,
    password: 'ConditionsPass123'
  })
  return store.requireUser(registered.token)
}

function conditionalTemplate(store, admin) {
  return store.createFormTemplate(admin, {
    name: 'Conditional Intake',
    sections: conditionalSections
  })
}

test('store submit: hidden required field missing is accepted', async () => {
  const store = await loadStore()
  const admin = registerFirm(store, 'Accept')
  const profile = store.createProfile(admin, { kind: 'client', firstName: 'A', lastName: 'B' })
  const template = conditionalTemplate(store, admin)
  const submission = store.createFormSubmission(admin, {
    clientId: profile.id,
    templateId: template.id,
    status: 'submitted',
    data: { hasSpouse: 'no' }
  })
  assert.equal(submission.status, 'submitted')
})

test('store submit: visible required field missing is rejected', async () => {
  const store = await loadStore()
  const admin = registerFirm(store, 'Reject')
  const profile = store.createProfile(admin, { kind: 'client', firstName: 'A', lastName: 'B' })
  const template = conditionalTemplate(store, admin)
  assert.throws(
    () =>
      store.createFormSubmission(admin, {
        clientId: profile.id,
        templateId: template.id,
        status: 'submitted',
        data: { hasSpouse: 'yes' }
      }),
    (error) => {
      assert.equal(error.code, 'FORMS_REQUIRED_FIELDS_MISSING')
      assert.equal(error.statusCode, 400)
      assert.equal(error.details.missing[0].fieldKey, 'spouseName')
      return true
    }
  )
})

test('store submit: visible required field filled is accepted', async () => {
  const store = await loadStore()
  const admin = registerFirm(store, 'Filled')
  const profile = store.createProfile(admin, { kind: 'client', firstName: 'A', lastName: 'B' })
  const template = conditionalTemplate(store, admin)
  const submission = store.createFormSubmission(admin, {
    clientId: profile.id,
    templateId: template.id,
    status: 'submitted',
    data: { hasSpouse: 'yes', spouseName: 'Sam' }
  })
  assert.equal(submission.status, 'submitted')
})

test('store submit: draft saves skip required validation', async () => {
  const store = await loadStore()
  const admin = registerFirm(store, 'Draft')
  const profile = store.createProfile(admin, { kind: 'client', firstName: 'A', lastName: 'B' })
  const template = conditionalTemplate(store, admin)
  const draft = store.createFormSubmission(admin, {
    clientId: profile.id,
    templateId: template.id,
    status: 'draft',
    data: { hasSpouse: 'yes' }
  })
  assert.equal(draft.status, 'draft')
})
