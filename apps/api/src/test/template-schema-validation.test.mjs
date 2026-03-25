import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-schema-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-template-schema'
    const moduleUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Schema Test Firm',
    firstName: 'Avery',
    lastName: 'Validator',
    email: `schema-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'TemplateSchema123!'
  })
  return store.requireUser(session.token)
}

test('rejects invalid transform registry type with descriptive error path', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  assert.throws(
    () => {
      store.createDocumentTemplate(user, {
        name: 'Invalid transforms',
        mappings: [
          {
            pdfField: 'client_phone',
            sourcePath: 'profile.phone',
            transform: { type: 'unknown_transform' }
          }
        ]
      })
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.equal(error.statusCode, 400)
      assert.equal(error.details.issues[0].path, '/mappings/0/transform/type')
      return true
    }
  )
})

test('rejects repeater path mismatch when mapping source path leaves repeater boundary', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Repeater base',
    formSchema: {
      sections: [
        {
          key: 'household',
          fields: [
            {
              path: 'members',
              type: 'repeater',
              fields: [{ path: 'firstName', type: 'text' }]
            }
          ]
        }
      ]
    },
    mappings: [{ pdfField: 'member_name', sourcePath: 'members.firstName', repeaterPath: 'members' }]
  })

  assert.throws(
    () => {
      store.updateTemplateMappings(user, template.id, [
        { pdfField: 'member_name', sourcePath: 'profile.lastName', repeaterPath: 'members' }
      ])
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.equal(error.details.issues[0].path, '/mappings/0/sourcePath')
      return true
    }
  )
})

test('converts legacy mapping shape and allows publish after compatibility conversion', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Legacy mapping template',
    mappings: [
      {
        field: 'client_dob',
        path: 'profile.dateOfBirth',
        transform: 'custom',
        expression: 'value'
      }
    ]
  })

  assert.equal(template.mappings[0].pdfField, 'client_dob')
  assert.equal(template.mappings[0].sourcePath, 'profile.dateOfBirth')
  assert.equal(template.mappings[0].transform.type, 'expression')

  const published = store.publishTemplate(user, template.id)
  assert.equal(published.publishState, 'published')
})
