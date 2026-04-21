import { PDFDocument } from 'pdf-lib'

export const TEMPLATE_WORKFLOW_FIELD_NAMES = Object.freeze({
  clientName: 'client_name',
  salary: 'salary',
  started: 'started',
  retired: 'retired',
  missingWithDefault: 'missing_with_default',
  dependentOneName: 'dependents_1_name',
  dependentTwoName: 'dependents_2_name'
})

export async function createTemplateWorkflowPdf(options = {}) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  const fields = { ...TEMPLATE_WORKFLOW_FIELD_NAMES, ...(options.fields || {}) }

  form.createTextField(fields.clientName).addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField(fields.salary).addToPage(page, { x: 72, y: 660, width: 160, height: 24 })
  form.createTextField(fields.started).addToPage(page, { x: 72, y: 620, width: 160, height: 24 })
  form.createCheckBox(fields.retired).addToPage(page, { x: 72, y: 580, width: 18, height: 18 })
  form.createTextField(fields.missingWithDefault).addToPage(page, { x: 72, y: 540, width: 240, height: 24 })
  form.createTextField(fields.dependentOneName).addToPage(page, { x: 72, y: 500, width: 240, height: 24 })
  form.createTextField(fields.dependentTwoName).addToPage(page, { x: 72, y: 460, width: 240, height: 24 })

  return Buffer.from(await pdf.save())
}

export function pdfBytesForJson(bytes) {
  return Array.from(Buffer.from(bytes))
}
