import test from 'node:test'
import assert from 'node:assert/strict'

import { buildExportArtifact } from '../export-artifact.mjs'
import { resolveExportData, computeMappingVersionHash } from '../export-data-resolution.mjs'

test('resolveExportData deterministically applies source evaluation + defaults + formatting', () => {
  const mappings = [
    { pdfField: 'client_name', sourcePath: 'profile.firstName' },
    { pdfField: 'salary', sourcePath: 'salary', transform: { type: 'currency' } },
    { pdfField: 'start_date', sourcePath: 'startDate', transform: { type: 'date' } },
    { pdfField: 'retired', sourcePath: 'isRetired', transform: { type: 'checkbox' } },
    { pdfField: 'fallback', sourcePath: 'missing.path', defaultValue: 'N/A' }
  ]

  const resolved = resolveExportData({
    mappings,
    profile: { firstName: 'Pat' },
    submission: { data: { salary: 1250.5, startDate: '2024-03-12', isRetired: false } }
  })

  const rows = Object.fromEntries(resolved.rows.map((row) => [row.pdfField, row.value]))
  assert.equal(rows.client_name, 'Pat')
  assert.equal(rows.salary, '$1,250.50')
  assert.equal(rows.start_date, '2024-03-12')
  assert.equal(rows.retired, 'No')
  assert.equal(rows.fallback, 'N/A')
  assert.equal(resolved.mappingVersionHash, computeMappingVersionHash(mappings))
})

test('buildExportArtifact emits stable metadata and checksum', () => {
  const job = {
    id: 'job-1',
    firmId: 'firm-1',
    clientId: 'client-1',
    templateId: 'template-1',
    type: 'pdf',
    execution: { leasedAt: '2026-03-25T12:00:00.000Z' },
    renderContext: {
      template: {
        versionHash: 'tpl-hash-123',
        mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }]
      },
      client: { firstName: 'Alex' },
      submission: { data: {} }
    }
  }

  const artifact = buildExportArtifact(job)
  assert.equal(artifact.artifact.generatedAt, '2026-03-25T12:00:00.000Z')
  assert.equal(artifact.artifact.templateVersion, 'tpl-hash-123')
  assert.equal(artifact.artifact.mappingVersionHash, artifact.preview.mappingVersionHash)
  assert.equal(artifact.artifact.checksum, artifact.object.checksum)
  assert.equal(artifact.preview.rows[0].value, 'Alex')
})
