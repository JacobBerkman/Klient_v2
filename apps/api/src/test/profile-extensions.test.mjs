import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profile-extensions-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-profile-extensions'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

test('createProfile computes financial summary from extension fallback values', async () => {
  const store = await loadStore()
  const user = { ...store.state.users.find((entry) => entry.role === 'admin') }
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Jordan',
    lastName: 'Client',
    extensions: {
      schemaVersion: '1.0.0',
      schema: { properties: { investableAssets: { type: 'number' }, annualIncome: { type: 'number' } } },
      values: { investableAssets: 250000, annualIncome: 150000 }
    }
  })
  assert.equal(profile.financialSummary.investableAssets, 250000)
  assert.equal(profile.financialSummary.annualIncome, 150000)
  assert.equal(profile.financialSummary.totalAssets, 250000)
})

test('updateProfile rejects invalid extension value type based on schema metadata', async () => {
  const store = await loadStore()
  const user = { ...store.state.users.find((entry) => entry.role === 'admin') }
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Taylor',
    lastName: 'Client'
  })
  assert.throws(
    () =>
      store.updateProfile(user, profile.id, {
        extensions: {
          schemaVersion: '1.0.0',
          schema: { properties: { segment: { type: 'string' } } },
          values: { segment: 123 }
        }
      }),
    /Invalid extension field type/
  )
})

test('admin can create and update firm custom field schema entries', async () => {
  const store = await loadStore()
  const admin = { ...store.state.users.find((entry) => entry.role === 'admin') }

  const created = store.createProfileCustomField(admin, {
    key: 'risk_tolerance',
    type: 'text',
    label: 'Risk Tolerance',
    required: true,
    metadata: { group: 'planning' }
  })
  assert.equal(created.key, 'risk_tolerance')
  assert.equal(created.type, 'text')
  assert.equal(created.required, true)

  const updated = store.updateProfileCustomField(admin, 'risk_tolerance', {
    type: 'number',
    required: false
  })
  assert.equal(updated.type, 'number')
  assert.equal(updated.required, false)

  const schema = store.getProfileCustomFieldSchema(admin)
  assert.equal(schema.fields.length, 1)
  assert.equal(schema.fields[0].key, 'risk_tolerance')
  assert.equal(schema.fields[0].type, 'number')
})

test('custom field schema rejects invalid field type payloads', async () => {
  const store = await loadStore()
  const admin = { ...store.state.users.find((entry) => entry.role === 'admin') }

  assert.throws(
    () => store.createProfileCustomField(admin, { key: 'unsupported_field', type: 'object' }),
    /Custom field type must be one of/
  )
})

test('custom field schema store blocks readonly users from schema mutation', async () => {
  const store = await loadStore()
  const admin = { ...store.state.users.find((entry) => entry.role === 'admin') }
  const readonlyInvite = store.inviteUser(admin, { email: `readonly-custom-${Date.now()}@example.com`, role: 'readonly' })
  const readonlySession = store.acceptInvite({
    token: readonlyInvite.token,
    firstName: 'Readonly',
    lastName: 'Custom',
    password: 'ReadonlyPass123!'
  })
  const readonly = readonlySession.user

  assert.throws(
    () => store.createProfileCustomField(readonly, { key: 'readonly_blocked', type: 'text' }),
    /Missing permission/
  )
  assert.throws(() => store.deleteProfileCustomField(readonly, 'risk_tolerance'), /Missing permission/)
})

test('custom field schema remains tenant-isolated across firms', async () => {
  const store = await loadStore()
  const adminA = { ...store.state.users.find((entry) => entry.role === 'admin') }
  const firmBSession = store.register({
    firmName: 'Other Firm',
    firstName: 'Second',
    lastName: 'Admin',
    email: `firm-b-admin-${Date.now()}@example.com`,
    password: 'FirmBPass123!'
  })
  const adminB = firmBSession.user

  store.createProfileCustomField(adminA, {
    key: 'firm_a_only',
    type: 'text',
    label: 'Firm A Only',
    required: false
  })

  const schemaA = store.getProfileCustomFieldSchema(adminA)
  const schemaB = store.getProfileCustomFieldSchema(adminB)
  assert.equal(schemaA.fields.some((field) => field.key === 'firm_a_only'), true)
  assert.equal(schemaB.fields.some((field) => field.key === 'firm_a_only'), false)
  assert.throws(() => store.updateProfileCustomField(adminB, 'firm_a_only', { label: 'Blocked' }), /not found/i)
  assert.throws(() => store.deleteProfileCustomField(adminB, 'firm_a_only'), /not found/i)
})
