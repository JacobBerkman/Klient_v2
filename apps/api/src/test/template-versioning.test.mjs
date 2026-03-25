import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const previousCwd = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'klient-template-versioning-'))
process.chdir(tempDir)
process.env.APP_SECRET = 'test-secret-for-template-versioning'
const moduleUrl = pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}`
const imported = await import(moduleUrl)
const store = imported.createStore()

function loginAdmin() {
  const session = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  return store.requireUser(session.token)
}

test('publish requires version bump + changelog and produces immutable snapshot', () => {
  const admin = loginAdmin()
  const created = store.createDocumentTemplate(admin, {
    name: 'Template A',
    fileName: 'a.pdf',
    blueprint: { sections: [{ title: 'A' }] },
    mappings: [{ key: 'a', source: 'profile.a' }]
  })

  assert.throws(() => store.publishTemplate(admin, created.id, { changelog: 'missing bump' }), /versionBump/)
  assert.throws(() => store.publishTemplate(admin, created.id, { versionBump: '1.0.0' }), /changelog/)

  const published = store.publishTemplate(admin, created.id, {
    versionBump: '1.0.0',
    changelog: 'Initial release'
  })
  const publishVersion = published.versions.find((entry) => entry.event === 'published')
  assert.equal(publishVersion?.immutable, true)
  assert.equal(publishVersion?.changelog?.versionBump, '1.0.0')
})

test('inspector saves enforce optimistic concurrency with expected version hash', () => {
  const admin = loginAdmin()
  const created = store.createDocumentTemplate(admin, {
    name: 'Template B',
    blueprint: { sections: [{ title: 'B' }] },
    mappings: [{ key: 'b', source: 'profile.b' }]
  })

  const staleHash = created.versionHash
  const firstSave = store.updateTemplateMappings(admin, created.id, [{ key: 'b2', source: 'profile.b2' }], {
    expectedVersionHash: staleHash
  })
  assert.notEqual(firstSave.versionHash, staleHash)
  assert.throws(
    () =>
      store.updateTemplateMappings(admin, created.id, [{ key: 'b3', source: 'profile.b3' }], {
        expectedVersionHash: staleHash
      }),
    /Template has changed/
  )
})

test('compare + revert produce deterministic rollback payloads', () => {
  const admin = loginAdmin()
  const created = store.createDocumentTemplate(admin, {
    name: 'Template C',
    blueprint: { sections: [{ title: 'Original' }] },
    mappings: [{ key: 'c', source: 'profile.c' }]
  })

  store.updateTemplateMappings(admin, created.id, [{ key: 'c2', source: 'profile.c2' }], {
    expectedVersionHash: created.versionHash
  })

  const compare = store.compareTemplateVersions(admin, created.id, 1, 2)
  assert.equal(compare.diff.mappingsChanged, true)

  const rollbackOne = store.revertTemplateVersion(admin, created.id, 1, { changelog: 'Rollback 1' })
  const rollbackTwo = store.revertTemplateVersion(admin, created.id, 1, { changelog: 'Rollback 2' })

  assert.deepEqual(rollbackOne.template.blueprint, rollbackTwo.template.blueprint)
  assert.deepEqual(rollbackOne.template.mappings, rollbackTwo.template.mappings)
  assert.equal(rollbackOne.revertedToVersion, 1)
  assert.equal(rollbackTwo.revertedToVersion, 1)
})

test('publish enforces known source-path validation when requested', () => {
  const admin = loginAdmin()
  const created = store.createDocumentTemplate(admin, {
    name: 'Template Publish Guard',
    blueprint: { sections: [{ title: 'Guard' }] },
    mappings: [{ pdfField: 'bad_field', sourcePath: 'profile.thisPathDoesNotExist' }]
  })

  assert.throws(
    () => {
      store.publishTemplate(admin, created.id, {
        versionBump: '2.0.0',
        changelog: 'Attempt publish with invalid mapping',
        enforceKnownSourcePaths: true
      })
    },
    (error) => {
      assert.equal(error.code, 'SCHEMA_VALIDATION_FAILED')
      assert.equal(error.statusCode, 400)
      assert.equal(error.details?.issues?.[0]?.path, '/mappings/0/sourcePath')
      return true
    }
  )
})

process.chdir(previousCwd)


test('mapping inspector edits persist and create version snapshots', () => {
  const admin = loginAdmin()
  const created = store.createDocumentTemplate(admin, {
    name: 'Template Inspector Persist',
    mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName', targetType: 'text' }],
    requiredPdfFields: ['client_name']
  })

  const updated = store.updateTemplateMappings(
    admin,
    created.id,
    [
      {
        pdfField: 'client_name',
        fieldLabel: 'Client Name',
        sourcePath: 'profile.firstName',
        targetType: 'text',
        defaultValue: 'Unknown',
        required: true,
        enabled: true,
        transform: { type: 'expression', expression: 'value' }
      }
    ],
    { expectedVersionHash: created.versionHash, requiredPdfFields: ['client_name'] }
  )

  assert.equal(updated.mappings[0].fieldLabel, 'Client Name')
  assert.equal(updated.mappings[0].defaultValue, 'Unknown')
  assert.equal(updated.mappings[0].required, true)
  assert.equal(updated.mappings[0].enabled, true)
  assert.equal(updated.mappings[0].transform.type, 'expression')
  assert.ok(updated.versions.length >= 2)
  const mappingVersion = updated.versions.find((entry) => entry.event === 'mappings_updated')
  assert.ok(mappingVersion)
})
