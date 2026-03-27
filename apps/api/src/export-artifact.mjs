import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { resolveExportData, computeMappingVersionHash } from './export-data-resolution.mjs'

const FORMAT_MAP = {
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

const PDF_PAGE = {
  width: 612,
  height: 792,
  marginTop: 48,
  marginBottom: 44,
  marginX: 46
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

function cleanText(value) {
  return String(value ?? '').replaceAll(/\s+/g, ' ').trim()
}

function wrapPdfText(line, maxChars = 90) {
  const text = cleanText(line)
  if (!text) return ['']
  const chunks = []
  let remaining = text
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(' ', maxChars)
    if (splitAt < 20) splitAt = maxChars
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  chunks.push(remaining)
  return chunks
}

function summarizeRowValue(rowValue) {
  if (rowValue == null) return ''
  if (Array.isArray(rowValue)) {
    if (!rowValue.length) return ''
    return rowValue
      .map((entry) => (entry && typeof entry === 'object' ? JSON.stringify(entry) : String(entry)))
      .join('; ')
  }
  if (rowValue && typeof rowValue === 'object') return JSON.stringify(rowValue)
  return String(rowValue)
}

function classifySection(row) {
  const path = String(row?.sourcePath || '').trim()
  if (path.startsWith('profile.')) return 'Client Profile'
  if (path.startsWith('submission.') || path.startsWith('form.')) return 'Form Submission'
  if (!path) return 'Mapped Values'
  const root = path.split('.')[0]
  if (root === 'profile') return 'Client Profile'
  if (root === 'submission' || root === 'form') return 'Form Submission'
  return 'Mapped Values'
}

function buildSectionGroups(rows = []) {
  const groups = new Map()
  for (const row of rows) {
    const section = classifySection(row)
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push(row)
  }
  return Array.from(groups.entries()).map(([name, entries]) => ({ name, entries }))
}

function formatRowForPdf(row, index) {
  const label = row.fieldLabel || row.pdfField || `Field ${index + 1}`
  const value = row.value
  const source = row.sourcePath || 'n/a'
  const warningSummary = row.warnings?.length ? row.warnings.map((warning) => warning.code || 'warning').join(', ') : 'OK'
  const lines = [`${index + 1}. ${label}`]
  lines.push(`Source: ${source}`)
  lines.push(`Status: ${warningSummary}`)
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push('Value: (empty list)')
    } else {
      const objectRows = value.filter((entry) => entry && typeof entry === 'object')
      if (objectRows.length === value.length) {
        const columns = Array.from(new Set(objectRows.flatMap((entry) => Object.keys(entry)))).slice(0, 6)
        lines.push(`Columns: ${columns.join(' | ') || 'n/a'}`)
        value.forEach((entry, rowIndex) => {
          const tuple = columns.map((column) => cleanText(entry[column] ?? '')).join(' | ')
          lines.push(`- Row ${rowIndex + 1}: ${tuple}`)
        })
      } else {
        value.forEach((entry, rowIndex) => lines.push(`- ${rowIndex + 1}: ${cleanText(entry)}`))
      }
    }
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => lines.push(`${key}: ${cleanText(entry)}`))
  } else {
    lines.push(`Value: ${summarizeRowValue(value)}`)
  }
  return lines
}

function createPdfArtifact({ job, metadata, resolvedRows = [] }) {
  const branding = metadata.branding || {}
  const title = cleanText(metadata.documentTitle || `${branding.firmName || 'Klient'} Export Packet`)
  const subtitle = cleanText(metadata.documentSubtitle || `${metadata.templateLabel || 'Template Export'} · ${job.clientId}`)
  const headerText = cleanText(branding.headerText || `${branding.firmName || 'Klient'} • Confidential`)
  const footerText = cleanText(branding.footerText || 'For advisor use only')

  const grouped = buildSectionGroups(resolvedRows)
  const metadataLines = [
    `Export Job: ${job.id}`,
    `Firm: ${job.firmId}`,
    `Client: ${job.clientId}`,
    `Template: ${metadata.templateLabel || job.templateId}`,
    `Generated: ${metadata.generatedAt}`,
    `Template Version: ${metadata.templateVersion}`,
    `Mapping Hash: ${metadata.mappingVersionHash}`
  ]
  const bodyTokens = []
  if (!grouped.length) {
    bodyTokens.push({ text: 'No mapping rows resolved for this export.', style: 'body' })
  } else {
    let globalIndex = 0
    for (const group of grouped) {
      bodyTokens.push({ text: group.name, style: 'section' })
      for (const row of group.entries) {
        const lines = formatRowForPdf(row, globalIndex)
        lines.forEach((line, lineIndex) => bodyTokens.push({ text: line, style: lineIndex === 0 ? 'bodyStrong' : 'body' }))
        bodyTokens.push({ text: '', style: 'body' })
        globalIndex += 1
      }
    }
  }

  const lineHeightByStyle = {
    header: 12,
    footer: 10,
    title: 20,
    subtitle: 13,
    meta: 11,
    section: 14,
    bodyStrong: 12,
    body: 11
  }
  const topY = PDF_PAGE.height - PDF_PAGE.marginTop
  const bodyStartY = topY - 86
  const bodyBottomY = PDF_PAGE.marginBottom + 30
  const continuationHeader = { text: 'Continued', style: 'section' }
  const pageBodies = []
  let cursor = 0
  while (cursor < bodyTokens.length || pageBodies.length === 0) {
    const pageTokens = []
    let y = pageBodies.length === 0 ? bodyStartY : bodyStartY + 18
    if (pageBodies.length > 0) {
      pageTokens.push(continuationHeader)
      y -= lineHeightByStyle.section
    }
    while (cursor < bodyTokens.length) {
      const token = bodyTokens[cursor]
      const wrapped = wrapPdfText(token.text, token.style === 'section' ? 74 : 92)
      const styleHeight = lineHeightByStyle[token.style] || 11
      const needed = wrapped.length * styleHeight
      if (y - needed < bodyBottomY) break
      wrapped.forEach((line) => {
        pageTokens.push({ text: line, style: token.style })
        y -= styleHeight
      })
      cursor += 1
    }
    pageBodies.push(pageTokens)
    if (cursor >= bodyTokens.length) break
  }

  const objects = []
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')

  const pageObjectIds = []
  const contentObjectIds = []
  const fontBodyId = 3 + pageBodies.length * 2
  const fontBoldId = fontBodyId + 1

  for (let index = 0; index < pageBodies.length; index += 1) {
    const pageObjectId = 3 + index * 2
    const contentObjectId = pageObjectId + 1
    pageObjectIds.push(pageObjectId)
    contentObjectIds.push(contentObjectId)
  }

  objects.push(`<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`)

  for (let pageIndex = 0; pageIndex < pageBodies.length; pageIndex += 1) {
    const pageId = pageObjectIds[pageIndex]
    const contentId = contentObjectIds[pageIndex]
    const tokens = pageBodies[pageIndex]

    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] /Resources << /Font << /F1 ${fontBodyId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`

    const textOps = ['BT']
    textOps.push('/F2 10 Tf')
    textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${topY} Tm`)
    textOps.push(`(${pdfEscape(headerText)}) Tj`)
    textOps.push(`/F2 18 Tf`)
    textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${topY - 28} Tm`)
    textOps.push(`(${pdfEscape(title)}) Tj`)
    textOps.push(`/F1 11 Tf`)
    textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${topY - 48} Tm`)
    textOps.push(`(${pdfEscape(subtitle)}) Tj`)
    metadataLines.forEach((line, idx) => {
      textOps.push(`/F1 9 Tf`)
      textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${topY - 66 - idx * 11} Tm`)
      textOps.push(`(${pdfEscape(line)}) Tj`)
    })
    const pageNumberText = `Page ${pageIndex + 1} of ${pageBodies.length}`
    textOps.push('/F1 9 Tf')
    textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${PDF_PAGE.marginBottom} Tm`)
    textOps.push(`(${pdfEscape(footerText)}) Tj`)
    textOps.push(`1 0 0 1 ${PDF_PAGE.width - 170} ${PDF_PAGE.marginBottom} Tm`)
    textOps.push(`(${pdfEscape(pageNumberText)}) Tj`)

    let y = pageIndex === 0 ? bodyStartY : bodyStartY + 18
    tokens.forEach((token) => {
      const style = token.style
      const fontOp =
        style === 'title' || style === 'section' || style === 'bodyStrong' || style === 'header' ? '/F2' : '/F1'
      const size =
        style === 'title' ? 18 : style === 'section' ? 12 : style === 'subtitle' ? 11 : style === 'meta' ? 9 : 10
      textOps.push(`${fontOp} ${size} Tf`)
      textOps.push(`1 0 0 1 ${PDF_PAGE.marginX} ${y} Tm`)
      textOps.push(`(${pdfEscape(token.text)}) Tj`)
      y -= lineHeightByStyle[style] || 11
    })
    textOps.push('ET')
    const stream = `${textOps.join('\n')}\n`
    const compressed = deflateRawSync(Buffer.from(stream, 'utf8'))
    objects[contentId - 1] = `<< /Length ${compressed.length} /Filter /FlateDecode >>
stream
${compressed.toString('binary')}
endstream`
  }

  objects[fontBodyId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[fontBoldId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'))
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'binary')
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
  const grouped = buildSectionGroups(resolvedRows)
  const overviewRows = [
    ['Klient Export Workbook', '', '', ''],
    ['Export Job', job.id, '', ''],
    ['Firm ID', job.firmId, '', ''],
    ['Client ID', job.clientId, '', ''],
    ['Template ID', job.templateId, '', ''],
    ['Generated At', metadata.generatedAt, '', ''],
    ['Template Version', metadata.templateVersion, '', ''],
    ['Mapping Hash', metadata.mappingVersionHash, '', ''],
    ['Rows Exported', resolvedRows.length, '', ''],
    ['', '', '', ''],
    ['Field', 'Value', 'Source Path', 'Status'],
    ...resolvedRows.map((row) => [
      row.fieldLabel || row.pdfField || '',
      summarizeRowValue(row.value),
      row.sourcePath || '',
      row.warnings?.length ? row.warnings.map((warning) => warning.code || 'warning').join(', ') : 'OK'
    ])
  ]

  const detailRows = [
    ['Section', 'Field', 'Value', 'Source Path', 'Raw Value', 'Status'],
    ...grouped.flatMap((group) =>
      group.entries.map((row) => [
        group.name,
        row.fieldLabel || row.pdfField || '',
        summarizeRowValue(row.value),
        row.sourcePath || '',
        summarizeRowValue(row.rawValue),
        row.warnings?.length ? row.warnings.map((warning) => warning.code || 'warning').join(', ') : 'OK'
      ])
    )
  ]

  const sharedStrings = []
  const sharedIndex = new Map()
  const sharedStringId = (value) => {
    const normalized = String(value ?? '')
    if (sharedIndex.has(normalized)) return sharedIndex.get(normalized)
    const id = sharedStrings.length
    sharedStrings.push(normalized)
    sharedIndex.set(normalized, id)
    return id
  }

  const sheetRows = overviewRows
    .map((row, idx) => {
      const rowIndex = idx + 1
      const rowCells = row
        .map((value, colIndex) => {
          const col = String.fromCharCode(65 + colIndex)
          const id = sharedStringId(value)
          const isTitle = rowIndex === 1
          const isHeader = rowIndex === 11
          const style = isTitle ? ' s="2"' : isHeader ? ' s="1"' : ''
          return `<c r="${col}${rowIndex}" t="s"${style}><v>${id}</v></c>`
        })
        .join('')
      return `<row r="${rowIndex}">${rowCells}</row>`
    })
    .join('')
  const detailSheetRows = detailRows
    .map((row, idx) => {
      const rowIndex = idx + 1
      const rowCells = row
        .map((value, colIndex) => {
          const col = String.fromCharCode(65 + colIndex)
          const id = sharedStringId(value)
          const isHeader = rowIndex === 1
          const style = isHeader ? ' s="1"' : ''
          return `<c r="${col}${rowIndex}" t="s"${style}><v>${id}</v></c>`
        })
        .join('')
      return `<row r="${rowIndex}">${rowCells}</row>`
    })
    .join('')

  const sharedXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
    sharedStrings.map((value) => `<si><t>${sanitizeCell(value)}</t></si>`).join('') +
    '</sst>'

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
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
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
        `<dc:title>${sanitizeCell(`${metadata.templateLabel || 'Template'} Export`)}</dc:title><dc:creator>Klient</dc:creator><cp:lastModifiedBy>Klient</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${sanitizeCell(metadata.generatedAt)}</dcterms:created>` +
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${sanitizeCell(metadata.generatedAt)}</dcterms:modified>` +
        '</cp:coreProperties>'
    },
    {
      name: 'docProps/app.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Klient</Application><Company>Klient</Company></Properties>'
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Overview" sheetId="1" r:id="rId1"/><sheet name="Resolved Values" sheetId="2" r:id="rId4"/></sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '</Relationships>'
    },
    {
      name: 'xl/styles.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>'
    },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    {
      name: 'xl/worksheets/sheet1.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D${overviewRows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="11" topLeftCell="A12" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="60" customWidth="1"/><col min="3" max="3" width="45" customWidth="1"/><col min="4" max="4" width="28" customWidth="1"/></cols><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells><sheetData>${sheetRows}</sheetData><autoFilter ref="A11:D11"/></worksheet>`
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F${detailRows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="3" width="55" customWidth="1"/><col min="4" max="4" width="38" customWidth="1"/><col min="5" max="5" width="40" customWidth="1"/><col min="6" max="6" width="28" customWidth="1"/></cols><sheetData>${detailSheetRows}</sheetData><autoFilter ref="A1:F1"/></worksheet>`
    }
  ]

  return zipEntries(files)
}

function resolveArtifactParts(job) {
  const type = String(job?.type || job?.output?.artifact?.format || 'pdf').toLowerCase()
  const spec = FORMAT_MAP[type] || FORMAT_MAP.pdf
  const generatedAt =
    job?.output?.artifact?.generatedAt ||
    job?.execution?.leasedAt ||
    job?.completedAt ||
    job?.updatedAt ||
    job?.createdAt ||
    new Date().toISOString()
  const safeFirm = String(job?.firmId || 'firm').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const safeClient = String(job?.clientId || 'client').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const timestampSegment = generatedAt.replaceAll(/[-:TZ.]/g, '').slice(0, 14) || '00000000000000'
  const fileName = `export-${safeFirm}-${safeClient}-${timestampSegment}.${spec.extension}`

  const renderContext = job?.renderContext || {}
  const template = renderContext.template || {}
  const templateMappings = template.mappings || []
  const resolved =
    renderContext.resolved ||
    resolveExportData({
      mappings: templateMappings,
      profile: renderContext.client || null,
      submission: renderContext.submission || null
    })

  const metadata = {
    templateVersion: template.versionHash || template.version || job?.output?.artifact?.templateVersion || 'unknown',
    mappingVersionHash:
      resolved.mappingVersionHash ||
      job?.output?.artifact?.mappingVersionHash ||
      computeMappingVersionHash(templateMappings),
    generatedAt,
    templateLabel: template.name || template.id || job.templateId || 'Template',
    documentTitle: job?.metadata?.documentTitle || null,
    documentSubtitle: job?.metadata?.documentSubtitle || null,
    branding: {
      firmName: job?.renderContext?.firm?.name || job?.metadata?.firmName || 'Klient',
      headerText: job?.metadata?.headerText || job?.renderContext?.firm?.branding?.pdfHeader || null,
      footerText: job?.metadata?.footerText || job?.renderContext?.firm?.branding?.pdfFooter || null
    }
  }

  const body =
    type === 'xlsx'
      ? createXlsxArtifact({ job, metadata, resolvedRows: resolved.rows })
      : createPdfArtifact({ job, metadata, resolvedRows: resolved.rows })
  const checksum = createHash('sha256').update(body).digest('hex')

  return { type, spec, fileName, metadata, resolvedRows: resolved.rows, body, checksum }
}

export function buildExportArtifactPayload(job) {
  const { type, spec, fileName, metadata, resolvedRows, body, checksum } = resolveArtifactParts(job)
  return {
    fileName,
    contentType: spec.contentType,
    body,
    preview: {
      clientId: job.clientId,
      templateId: job.templateId,
      templateVersion: metadata.templateVersion,
      mappingVersionHash: metadata.mappingVersionHash,
      generatedAt: metadata.generatedAt,
      rows: resolvedRows
    },
    artifact: {
      format: type,
      generatedAt: metadata.generatedAt,
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

export function buildExportArtifact(job) {
  const payload = buildExportArtifactPayload(job)
  return {
    fileName: payload.fileName,
    preview: payload.preview,
    artifact: payload.artifact,
    object: payload.object
  }
}
