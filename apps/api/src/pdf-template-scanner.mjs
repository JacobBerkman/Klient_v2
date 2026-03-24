import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

function toBase64Payload(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('A base64 PDF payload is required.');
  return raw.includes(',') ? raw.split(',')[1] : raw;
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.filter((option) => typeof option === 'string' && option.trim()).map((option) => option.trim());
}

function fieldType(field) {
  const name = field?.constructor?.name || '';
  if (/TextField/.test(name)) return 'text';
  if (/CheckBox/.test(name)) return 'checkbox';
  if (/RadioGroup/.test(name)) return 'radio';
  if (/Dropdown/.test(name)) return 'select';
  if (/OptionList/.test(name)) return 'multiselect';
  if (/Button/.test(name)) return 'button';
  return 'unknown';
}

export async function scanTemplatePdf({ fileName, pdfBase64, mimeType = 'application/pdf' }) {
  const base64Payload = toBase64Payload(pdfBase64);
  const pdfBytes = Buffer.from(base64Payload, 'base64');
  if (!pdfBytes.length) throw new Error('Uploaded PDF is empty.');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const scannedAt = new Date().toISOString();
  const fields = form.getFields().map((field) => ({
    name: field.getName(),
    type: fieldType(field),
    isReadOnly: Boolean(field.isReadOnly?.()),
    isRequired: Boolean(field.isRequired?.()),
    options: normalizeOptions(field.getOptions?.())
  }));
  return {
    artifact: {
      fileName: fileName || 'uploaded.pdf',
      mimeType,
      sizeBytes: pdfBytes.length,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
      uploadedAt: scannedAt,
      source: 'upload',
      encoding: 'base64'
    },
    fieldInventory: {
      scannedAt,
      fieldCount: fields.length,
      fields
    },
    pdfBase64: base64Payload
  };
}
