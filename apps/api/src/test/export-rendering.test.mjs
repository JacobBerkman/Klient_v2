import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'

import { buildExportArtifact, buildExportArtifactPayload } from '../export-artifact.mjs'
import { resolveExportData, computeMappingVersionHash } from '../export-data-resolution.mjs'

function unzipEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset)
    if (signature !== 0x04034b50) break
    const compression = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const fileNameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const nameEnd = nameStart + fileNameLength
    const dataStart = nameEnd + extraLength
    const dataEnd = dataStart + compressedSize
    const name = buffer.slice(nameStart, nameEnd).toString('utf8')
    const compressed = buffer.slice(dataStart, dataEnd)
    const content = compression === 8 ? inflateRawSync(compressed).toString('utf8') : compressed.toString('utf8')
    entries.set(name, content)
    offset = dataEnd
  }
  return entries
}

function readPdfStreams(buffer) {
  const source = buffer.toString('binary')
  const matches = source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)
  const decoded = []
  for (const match of matches) {
    const binary = match[1]
    try {
      const inflated = inflateRawSync(Buffer.from(binary, 'binary')).toString('utf8')
      decoded.push(inflated)
    } catch {
      // ignore non-deflated stream fragments
    }
  }
  return decoded.join('\n')
}

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
  assert.match(artifact.fileName, /^export-firm-1-client-1-20260325120000\.pdf$/)
})


test('buildExportArtifact generates polished xlsx worksheet metadata', () => {
  const artifact = buildExportArtifactPayload({
    id: 'job-2',
    firmId: 'firm-2',
    clientId: 'client-2',
    templateId: 'template-2',
    type: 'xlsx',
    execution: { leasedAt: '2026-03-25T12:00:00.000Z' },
    renderContext: {
      template: {
        versionHash: 'tpl-hash-xyz',
        mappings: [
          { pdfField: 'client_name', fieldLabel: 'Client Name', sourcePath: 'profile.firstName' },
          { pdfField: 'goal', sourcePath: 'submission.goal' }
        ]
      },
      client: { firstName: 'Jordan' },
      submission: { data: { goal: 'Launch retirement plan' } }
    }
  })

  assert.equal(artifact.object.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.ok(artifact.artifact.sizeBytes > 0)
  const files = unzipEntries(artifact.body)
  assert.ok(files.has('xl/worksheets/sheet1.xml'))
  assert.ok(files.has('xl/worksheets/sheet2.xml'))
  assert.match(files.get('xl/worksheets/sheet1.xml') || '', /autoFilter ref="A11:D11"/)
  assert.match(files.get('xl/worksheets/sheet1.xml') || '', /pane ySplit="11"/)
  assert.match(files.get('xl/workbook.xml') || '', /sheet name="Resolved Values"/)
  assert.match(files.get('docProps\/core.xml') || '', /tpl-hash-xyz|template-2|Template/)
})

test('buildExportArtifact renders branded PDF headers and grouped mapping sections', () => {
  const artifact = buildExportArtifactPayload({
    id: 'job-brand-1',
    firmId: 'firm-brand',
    clientId: 'client-brand',
    templateId: 'template-brand',
    type: 'pdf',
    execution: { leasedAt: '2026-03-25T12:00:00.000Z' },
    metadata: {
      headerText: 'Northstar Wealth | Advisor Copy',
      footerText: 'Confidential – Internal Distribution'
    },
    renderContext: {
      firm: { name: 'Northstar Wealth' },
      template: {
        name: 'Retirement Intake',
        versionHash: 'tpl-brand',
        mappings: [
          { pdfField: 'name', sourcePath: 'profile.firstName' },
          { pdfField: 'goals', sourcePath: 'submission.goals' }
        ]
      },
      client: { firstName: 'Sam' },
      submission: { data: { goals: [{ type: 'Retirement', amount: 300000 }] } }
    }
  })

  const bodyText = readPdfStreams(artifact.body)
  assert.match(bodyText, /Northstar Wealth \| Advisor Copy/)
  assert.match(bodyText, /Confidential – Internal Distribution/)
  assert.match(bodyText, /Client Profile/)
  assert.match(bodyText, /Form Submission/)
})

test('resolveExportData supports explicit submission/form prefixes and legacy bare paths', () => {
  const result = resolveExportData({
    mappings: [
      { pdfField: 'legacy_goal', sourcePath: 'goal' },
      { pdfField: 'submission_goal', sourcePath: 'submission.goal' },
      { pdfField: 'form_goal', sourcePath: 'form.goal' },
      { pdfField: 'profile_name', sourcePath: 'firstName' }
    ],
    profile: { firstName: 'Taylor' },
    submission: { data: { goal: 'Pay off mortgage' } }
  })

  const mapped = Object.fromEntries(result.rows.map((row) => [row.pdfField, row.value]))
  assert.equal(mapped.legacy_goal, 'Pay off mortgage')
  assert.equal(mapped.submission_goal, 'Pay off mortgage')
  assert.equal(mapped.form_goal, 'Pay off mortgage')
  assert.equal(mapped.profile_name, 'Taylor')
})
