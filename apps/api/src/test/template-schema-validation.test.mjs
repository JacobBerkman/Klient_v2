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
      assert.equal(error.details.issues[0].issueId, 'unsupported_transform_type:0:transform.type')
      assert.equal(error.details.issues[0].rowAnchor, '#mapping-row-0')
      assert.equal(error.details.issues[0].inspectorTarget, 'transform.type')
      assert.equal(error.details.issues[0].meta?.issueId, 'unsupported_transform_type:0:transform.type')
      return true
    }
  )
})

test('rejects common expression operator mistakes with actionable metadata', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  assert.throws(
    () => {
      store.createDocumentTemplate(user, {
        name: 'Expression mistakes',
        mappings: [
          {
            pdfField: 'eligibility',
            sourcePath: 'profile.firstName',
            transform: { type: 'expression', expression: '(value = "yes") AND (value ? "ok")' }
          }
        ]
      })
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      const issueCodes = (error.details?.issues || []).map((issue) => issue.code)
      assert.ok(issueCodes.includes('expression_operator_assignment'))
      assert.ok(issueCodes.includes('expression_operator_textual_logic'))
      assert.ok(issueCodes.includes('expression_incomplete_ternary'))
      const assignmentIssue = (error.details?.issues || []).find((issue) => issue.code === 'expression_operator_assignment')
      assert.equal(assignmentIssue?.field, 'transform.expression')
      assert.match(String(assignmentIssue?.meta?.suggestion || ''), /equality/i)
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

test('legacy and modern mapping payloads produce equivalent runtime preview output', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Jamie', lastName: 'Parity', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Legacy parity form',
    sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goal: 'Fund education' }
  })

  const modernTemplate = store.createDocumentTemplate(user, {
    name: 'Modern parity template',
    mappings: [
      { pdfField: 'client_first_name', sourcePath: 'profile.firstName', fieldLabel: 'First Name' },
      { pdfField: 'client_goal', sourcePath: 'submission.goal', transform: { type: 'expression', expression: 'value' } }
    ]
  })
  const legacyTemplate = store.createDocumentTemplate(user, {
    name: 'Legacy parity template',
    mappings: [
      { targetField: 'client_first_name', path: 'profile.firstName', label: 'First Name', isRequired: false },
      { field: 'client_goal', source: 'submission.goal', formatter: 'custom', expression: 'value' }
    ]
  })

  const modernPreview = store.previewTemplateMappings(user, modernTemplate.id, {
    clientId: profile.id,
    submissionId: submission.id
  })
  const legacyPreview = store.previewTemplateMappings(user, legacyTemplate.id, {
    clientId: profile.id,
    submissionId: submission.id
  })

  const modernRows = modernPreview.rows.map((row) => ({ pdfField: row.pdfField, sourcePath: row.sourcePath, value: row.value }))
  const legacyRows = legacyPreview.rows.map((row) => ({ pdfField: row.pdfField, sourcePath: row.sourcePath, value: row.value }))
  assert.deepEqual(legacyRows, modernRows)
})

test('firm custom profile fields participate in firm-aware preview + publish source path validation', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  store.createProfileCustomField(user, {
    key: 'risk_tolerance',
    type: 'text',
    label: 'Risk Tolerance'
  })

  const template = store.createDocumentTemplate(user, {
    name: 'Custom field mapping template',
    mappings: [{ pdfField: 'risk_tolerance', sourcePath: 'profile.extensions.values.risk_tolerance', required: true }],
    enforceKnownSourcePaths: true
  })
  const profile = store.createProfile(user, {
    kind: 'client',
    firstName: 'Quinn',
    lastName: 'Custom',
    stage: 'intake',
    extensions: { schemaVersion: '1.0.0', values: { risk_tolerance: 'Moderate' } }
  })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Custom field publish form',
    sections: [{ key: 'goal', label: 'Goal', type: 'text' }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { goal: 'Retire comfortably' }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })
  assert.equal(preview.rows[0].value, 'Moderate')

  const published = store.publishTemplate(user, template.id, {
    versionBump: '1.0.0',
    changelog: 'Publish custom field source path template',
    enforceKnownSourcePaths: true,
    clientId: profile.id,
    submissionId: submission.id
  })
  assert.equal(published.publishState, 'published')
})

test('auto-build template flow stays healthy with firm-aware source path validation enabled', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const built = store.autoBuildTemplate(user, {
    name: 'Auto-build regression guard',
    fileBytes: [0x25, 0x50, 0x44, 0x46, 0x2d]
  })

  assert.equal(built.name, 'Auto-build regression guard')
  assert.equal(built.extraction.status, 'failed')
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
  assert.equal(preview.issues[0].issueId, 'unknown_source_path:0:sourcePath')
  assert.equal(preview.issues[0].rowAnchor, '#mapping-row-0')
  assert.equal(preview.issues[0].inspectorTarget, 'sourcePath')
  assert.ok(preview.issues[0].meta?.issueId)
  assert.ok(preview.issues[0].rowId)
  assert.equal(preview.issues[0].meta?.rowId, preview.issues[0].rowId)
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

test('repeatable section mappings stay consistent across preview, publish preflight, and export runtime', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const template = store.createDocumentTemplate(user, {
    name: 'Repeatable parity template',
    formSchema: {
      sections: [
        {
          key: 'assets',
          repeatable: true,
          fields: [
            { path: 'accountName', type: 'text' },
            { path: 'value', type: 'number' }
          ]
        }
      ]
    },
    mappings: [
      { pdfField: 'asset_row', sourcePath: 'assets', repeaterPath: 'assets', required: true },
      { pdfField: 'asset_count', sourcePath: 'assets', transform: { type: 'expression', expression: 'value' } }
    ]
  })
  const profile = store.createProfile(user, { kind: 'client', firstName: 'Reese', lastName: 'Parity', stage: 'intake' })
  const formTemplate = store.createFormTemplate(user, {
    name: 'Repeatable source form',
    sections: [{ key: 'assets', label: 'Assets', repeatable: true, fields: [{ key: 'accountName', type: 'text' }] }]
  })
  const submission = store.createFormSubmission(user, {
    clientId: profile.id,
    templateId: formTemplate.id,
    status: 'submitted',
    data: { assets: [{ accountName: '401k', value: 100000 }, { accountName: 'Roth IRA', value: 45000 }] }
  })

  const preview = store.previewTemplateMappings(user, template.id, {
    clientId: profile.id,
    submissionId: submission.id
  })
  assert.deepEqual(preview.rows[0].value, submission.data.assets)
  assert.equal(preview.rows[0].warnings.length, 0)

  const published = store.publishTemplate(user, template.id, {
    versionBump: '1.0.0',
    changelog: 'Publish repeatable parity template',
    clientId: profile.id,
    submissionId: submission.id
  })
  assert.equal(published.publishState, 'published')

  const exportJob = store.createExport(user, {
    templateId: template.id,
    clientId: profile.id,
    submissionId: submission.id,
    type: 'json'
  })
  const previewRowByField = Object.fromEntries(preview.rows.map((row) => [row.pdfField, row]))
  const exportRowByField = Object.fromEntries((exportJob.renderContext?.resolved?.rows || []).map((row) => [row.pdfField, row]))
  assert.deepEqual(exportRowByField.asset_row?.value, previewRowByField.asset_row?.value)
  assert.equal(exportJob.renderContext?.resolved?.mappingVersionHash, preview.mappingVersionHash)
})
