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
      assert.equal(error.details.issues[0].code, 'unsupported_transform_type')
      assert.equal(error.details.issues[0].field, 'transform.type')
      assert.equal(error.details.issues[0].path, '/mappings/0/transform/type')
      assert.equal(error.details.issues[0].meta?.issueId, 'unsupported_transform_type:0:transform.type')
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
      assert.equal(error.details.issues[0].code, 'source_path_outside_repeater')
      assert.equal(error.details.issues[0].field, 'sourcePath')
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

  const published = store.publishTemplate(user, template.id, {
    versionBump: '1.0.0',
    changelog: 'Publish converted legacy mapping.'
  })
  assert.equal(published.publishState, 'published')
})

test('rejects duplicate targets, unknown paths, and missing required fields', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Required mapping checks',
    formSchema: { sections: [{ key: 's1', fields: [{ path: 'goals', type: 'text' }] }] },
    mappings: [
      { pdfField: 'client_name', sourcePath: 'profile.firstName' },
      { pdfField: 'client_goal', sourcePath: 'goals' }
    ],
    requiredPdfFields: ['client_name', 'client_goal']
  })

  assert.throws(
    () => {
      store.updateTemplateMappings(
        user,
        template.id,
        [
          { pdfField: 'client_name', sourcePath: 'profile.firstName' },
          { pdfField: 'client_name', sourcePath: 'unknown.path' }
        ],
        { requiredPdfFields: ['client_name', 'client_goal'] }
      )
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.match(JSON.stringify(error.details.issues), /Duplicate pdfField|not a known profile\/form schema path|Required mapping/)
      return true
    }
  )
})

test('mapping preview resolves values for selected client and submission', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Preview template',
    mappings: [
      { pdfField: 'first_name', sourcePath: 'profile.firstName' },
      { pdfField: 'goals', sourcePath: 'goals' }
    ]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Casey', lastName: 'Preview', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Preview Form',
    sections: [{ key: 'goals', label: 'Goals', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goals: 'Retire early' }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })

  assert.equal(preview.rows[0].value, profile.firstName)
  assert.ok(preview.rows.some((row) => row.pdfField === 'goals'))
})


test('mapping preview resolves profile and submission explicit path prefixes', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Prefix preview template',
    mappings: [
      { pdfField: 'first_name', sourcePath: 'profile.firstName' },
      { pdfField: 'goal_via_submission', sourcePath: 'submission.goals' },
      { pdfField: 'goal_via_form', sourcePath: 'form.goals' }
    ]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Morgan', lastName: 'Prefix', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Prefix Form',
    sections: [{ key: 'goals', label: 'Goals', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goals: 'Build emergency fund' }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })

  const valueByField = Object.fromEntries(preview.rows.map((row) => [row.pdfField, row.value]))
  assert.equal(valueByField.first_name, 'Morgan')
  assert.equal(valueByField.goal_via_submission, 'Build emergency fund')
  assert.equal(valueByField.goal_via_form, 'Build emergency fund')
})

test('preview returns blocking schema issues for missing mapping paths before publish', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Preview preflight guard',
    mappings: [{ pdfField: 'client_name', sourcePath: 'profile.unknownPathForPreflight' }]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Taylor', lastName: 'Guard', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Guard Form',
    sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goal: 'Validate early' }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })

  assert.ok(Array.isArray(preview.issues))
  assert.match(JSON.stringify(preview.issues), /known profile\/form schema path/i)
  assert.equal(preview.issues[0].code, 'unknown_source_path')
  assert.equal(preview.issues[0].field, 'sourcePath')
  assert.ok(preview.issues[0].meta?.issueId)
  assert.equal(preview.issues[0].blocking, true)
})

test('preview includes stable row identifiers and blocking/non-blocking warning summaries', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Preview row metadata',
    mappings: [
      { pdfField: 'required_first_name', sourcePath: 'profile.missingRequiredPath', required: true },
      { pdfField: 'optional_goal', sourcePath: 'missingOptionalPath' }
    ]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Robin', lastName: 'RowId', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Row metadata form',
    sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goal: 'Keep identifiers stable' }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })

  assert.ok(preview.rows.every((row) => typeof row.rowId === 'string' && row.rowId.length > 0))
  assert.equal(preview.rows[0].warningSummary.blocking, 1)
  assert.equal(preview.rows[1].warningSummary.nonBlocking, 1)
  assert.equal(preview.blockingWarningsCount, 1)
})

test('publish blocks when preview contains unresolved required mappings', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Publish blocking preview guard',
    mappings: [{ pdfField: 'required_first_name', sourcePath: 'profile.missingRequiredPath', required: true }]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Parker', lastName: 'Blocker', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Publish blocker form',
    sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goal: 'Should block publish' }
  })

  assert.throws(
    () =>
      store.publishTemplate(user, template.id, {
        versionBump: '1.0.0',
        changelog: 'Attempt publish with unresolved required mapping',
        clientId: profile.id,
        submissionId: submission.id
      }),
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.match(String(error.message), /Publish blocked/)
      assert.equal(error.details.issues[0].code, 'unresolved_source_path')
      assert.ok(error.details.issues[0].meta?.rowId)
      return true
    }
  )
})
