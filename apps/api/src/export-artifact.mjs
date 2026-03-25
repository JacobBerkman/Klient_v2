import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { resolveExportData, computeMappingVersionHash } from './export-data-resolution.mjs'

const FORMAT_MAP = {
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

function sanitizeCell(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function pdfEscape(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function createPdfArtifact({ job, metadata, resolvedRows = [] }) {
  const lines = [
    `Export Job: ${job.id}`,
    `Firm: ${job.firmId}`,
    `Client: ${job.clientId}`,
    `Template: ${job.templateId}`,
    `Generated: ${metadata.generatedAt}`,
    `Template Version: ${metadata.templateVersion}`,
    `Mapping Hash: ${metadata.mappingVersionHash}`
  ]
  for (const row of resolvedRows.slice(0, 24)) {
    lines.push(`${row.pdfField}: ${row.value ?? ''}`)
  }
  const text = ['BT', '/F1 12 Tf', '50 780 Td', `(${pdfEscape(lines[0])}) Tj`]
  for (let i = 1; i < lines.length; i += 1) {
    text.push('0 -18 Td')
    text.push(`(${pdfEscape(lines[i])}) Tj`)
  }
  text.push('ET')
  const stream = `${text.join('\n')}\n`
  const streamLength = Buffer.byteLength(stream)

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${stream}endstream\nendobj\n`
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += object
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipEntries(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const source = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8')
    const compressed = deflateRawSync(source)
    const crc = crc32(source)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(source.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(source.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, name)
    offset += localHeader.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, end])
}

function createXlsxArtifact({ job, metadata, resolvedRows = [] }) {
  const rows = [
    ['Export Job', job.id],
    ['Firm ID', job.firmId],
    ['Client ID', job.clientId],
    ['Template ID', job.templateId],
    ['Generated At', metadata.generatedAt],
    ['Template Version', metadata.templateVersion],
    ['Mapping Hash', metadata.mappingVersionHash]
  ]
  for (const row of resolvedRows) {
    rows.push([row.pdfField, row.value])
  }
  const sheetRows = rows
    .map(
      (row, idx) =>
        `<row r="${idx + 1}"><c r="A${idx + 1}" t="inlineStr"><is><t>${sanitizeCell(row[0])}</t></is></c><c r="B${
          idx + 1
        }" t="inlineStr"><is><t>${sanitizeCell(row[1])}</t></is></c></row>`
    )
    .join('')

  const files = [
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>'
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>'
    },
    {
      name: 'docProps/core.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>Klient Export</dc:title><dc:creator>Klient</dc:creator><cp:lastModifiedBy>Klient</cp:lastModifiedBy>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>' +
        '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified>' +
        '</cp:coreProperties>'
    },
    {
      name: 'docProps/app.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Klient</Application></Properties>'
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`
    }
  ]

  return zipEntries(files)
}

export function buildExportArtifact(job) {
  const type = String(job?.type || 'pdf').toLowerCase()
  const spec = FORMAT_MAP[type] || FORMAT_MAP.pdf
  const generatedAt = job?.execution?.leasedAt || new Date().toISOString()
  const fileName = `${type}-${Date.now()}.${spec.extension}`

  const renderContext = job?.renderContext || {}
  const template = renderContext.template || {}
  const templateMappings = template.mappings || []
  const resolved = renderContext.resolved || resolveExportData({
    mappings: templateMappings,
    profile: renderContext.client || null,
    submission: renderContext.submission || null
  })

  const metadata = {
    templateVersion: template.versionHash || template.version || 'unknown',
    mappingVersionHash: resolved.mappingVersionHash || computeMappingVersionHash(templateMappings),
    generatedAt
  }

  const body =
    type === 'xlsx'
      ? createXlsxArtifact({ job, metadata, resolvedRows: resolved.rows })
      : createPdfArtifact({ job, metadata, resolvedRows: resolved.rows })
  const checksum = createHash('sha256').update(body).digest('hex')

  return {
    fileName,
    preview: {
      clientId: job.clientId,
      templateId: job.templateId,
      templateVersion: metadata.templateVersion,
      mappingVersionHash: metadata.mappingVersionHash,
      generatedAt: metadata.generatedAt,
      rows: resolved.rows
    },
    artifact: {
      format: type,
      generatedAt,
      sizeBytes: body.length,
      templateVersion: metadata.templateVersion,
      mappingVersionHash: metadata.mappingVersionHash,
      checksum
    },
    object: {
      keySuffix: spec.extension,
      contentType: spec.contentType,
      checksum,
      retentionClass: 'export_artifact'
    }
  }
}
