import {
  apiFromPage,
  deterministicEmail,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'
import { createTemplateWorkflowPdf } from '../../scripts/pdf-fixtures.mjs'

test('@release-blocking routed template detail supports preview and publish controls', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'template-route')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const clientResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Template',
      lastName: 'Route',
      email: deterministicEmail(seededRunId, 'template-route-client')
    },
    auth
  )
  expect(clientResponse.status).toBe(201)
  const client = clientResponse.body

  const formTemplateResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/templates',
    {
      name: `Template Detail Source ${seededRunId}`,
      sections: [{ title: 'Goals', fields: [{ key: 'goal', label: 'Goal', type: 'text' }] }]
    },
    auth
  )
  expect(formTemplateResponse.status).toBe(201)
  const formTemplate = formTemplateResponse.body

  const submissionResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/submissions',
    {
      clientId: client.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: { goal: 'Validate routed template preview' }
    },
    auth
  )
  expect(submissionResponse.status).toBe(201)

  const documentTemplateResponse = await apiFromPage(
    page,
    'POST',
    '/api/templates',
    {
      name: `Routed Publish Template ${seededRunId}`,
      fileName: 'routed-publish-template.pdf',
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.firstName', required: true }]
    },
    auth
  )
  expect(documentTemplateResponse.status).toBe(201)
  const documentTemplate = documentTemplateResponse.body

  await page.goto(`/templates/${documentTemplate.id}`)

  await expect(page.getByRole('heading', { name: documentTemplate.name })).toBeVisible()
  await expect(page.getByText('Template editor')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mappings' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Client' }).selectOption(client.id)
  await page.getByRole('combobox', { name: 'Submission' }).selectOption(submissionResponse.body.id)
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect(page.getByText('Preview generated.')).toBeVisible()

  await page.getByLabel('Version bump').fill('1.0.0')
  await page.getByLabel('Publish changelog').fill('Initial routed publish')
  await page.getByRole('button', { name: 'Publish template' }).click()
  await expect(page.getByText('Template published.')).toBeVisible()
})

test('@release-blocking routed portal token lifecycle saves draft and submits form', async ({ page, seededRunId }) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'portal-route')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const profileResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Portal',
      lastName: 'Route',
      email: deterministicEmail(seededRunId, 'portal-route-client')
    },
    auth
  )
  expect(profileResponse.status).toBe(201)
  const profile = profileResponse.body

  const templateResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/templates',
    {
      name: `Portal Route Intake ${seededRunId}`,
      sections: [{ title: 'Goals', fields: [{ key: 'goal', label: 'Goal', type: 'text', required: true }] }]
    },
    auth
  )
  expect(templateResponse.status).toBe(201)
  const template = templateResponse.body

  const portalLinkResponse = await apiFromPage(
    page,
    'POST',
    '/api/portal-links',
    {
      profileId: profile.id,
      templateIds: [template.id],
      expiresInHours: 2,
      maxUses: 3
    },
    auth
  )
  expect(portalLinkResponse.status).toBe(201)
  const portalLink = portalLinkResponse.body

  await page.goto(`/portal?token=${portalLink.token}`)
  await expect(page.getByRole('heading', { name: `${profile.firstName} ${profile.lastName}` })).toBeVisible()
  await expect(page.getByText('Secure portal')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Complete a form' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Goal' }).fill('Save this as a routed portal draft')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Draft saved.')).toBeVisible()

  await page.getByRole('textbox', { name: 'Goal' }).fill('Submit this routed portal form')
  await page.getByRole('button', { name: 'Submit form' }).click()
  await expect(page.getByText('Form submitted.')).toBeVisible()
})

test('@release-blocking PDF template auto-build creates generated form and downloadable exports', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'document-flow')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const clientResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Document',
      lastName: 'Flow',
      email: deterministicEmail(seededRunId, 'document-flow-client')
    },
    auth
  )
  expect(clientResponse.status).toBe(201)
  const client = clientResponse.body

  const pdfBytes = await createTemplateWorkflowPdf()
  const templateName = `Document Flow Template ${seededRunId}`
  await page.goto('/templates')
  await page.getByLabel('Template name').fill(templateName)
  await page
    .getByLabel('PDF file')
    .setInputFiles({ name: 'document-flow.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdfBytes) })
  await page.getByRole('button', { name: 'Run auto-build' }).click()
  await expect(page.getByText(/Auto-build completed:/)).toBeVisible()
  await expect(page.getByText('Linked form generated')).toBeVisible()

  const templatesResponse = await apiFromPage(page, 'GET', '/api/templates', undefined, auth)
  expect(templatesResponse.status).toBe(200)
  const documentTemplate = templatesResponse.body.find((entry) => entry.name === templateName)
  expect(documentTemplate?.extraction?.status).toBe('completed')
  expect(documentTemplate?.sourceArtifact?.key).toBeTruthy()
  expect(documentTemplate?.linkedFormTemplateId).toBeTruthy()

  const formTemplatesResponse = await apiFromPage(page, 'GET', '/api/forms/templates', undefined, auth)
  expect(formTemplatesResponse.status).toBe(200)
  const generatedForm = formTemplatesResponse.body.find((entry) => entry.id === documentTemplate.linkedFormTemplateId)
  expect(generatedForm?.generatedFromDocumentTemplateId).toBe(documentTemplate.id)

  await page.goto(`/templates/${documentTemplate.id}`)
  await expect(page.getByRole('heading', { name: documentTemplate.name })).toBeVisible()
  await expect(page.getByText('source pdf persisted')).toBeVisible()
  await expect(page.getByText('ready')).toBeVisible()
  await expect(page.getByText(`Source document ID: ${documentTemplate.id}`)).toBeVisible()

  await page.getByRole('link', { name: 'Open visual mapper' }).click()
  await expect(page.getByRole('heading', { name: documentTemplate.name })).toBeVisible()
  await expect(page.getByText('source pdf available')).toBeVisible()
  await expect(page.getByText('mapping complete')).toBeVisible()
  await expect(page.getByText('layout saved')).toBeVisible()
  const overlay = page.getByTestId('pdf-field-overlay-client_name')
  await expect(overlay).toBeVisible()
  const overlayBox = await overlay.boundingBox()
  expect(overlayBox).toBeTruthy()
  await page.mouse.move(overlayBox.x + 10, overlayBox.y + 10)
  await page.mouse.down()
  await page.mouse.move(overlayBox.x + 38, overlayBox.y + 18)
  await page.mouse.up()
  const resize = page.getByTestId('pdf-field-resize-client_name')
  const resizeBox = await resize.boundingBox()
  expect(resizeBox).toBeTruthy()
  await page.mouse.move(resizeBox.x + 3, resizeBox.y + 3)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + 28, resizeBox.y + 14)
  await page.mouse.up()
  await expect(page.getByText('unsaved layout changes')).toBeVisible()
  await page.getByRole('button', { name: 'Save PDF layout' }).click()
  await expect(page.getByText('PDF layout saved.')).toBeVisible()
  await expect(page.getByText('layout saved')).toBeVisible()
  const previewPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Generate test-fill preview' }).click()
  const previewPage = await previewPromise
  await previewPage.close()
  await expect(page.getByText('Test-fill preview generated.')).toBeVisible()

  await page.goto(`/templates/${documentTemplate.id}`)
  await page.getByLabel('Version bump').fill('1.0.0')
  await page.getByLabel('Publish changelog').fill('Publish generated document flow template')
  await page.getByRole('button', { name: 'Publish template' }).click()
  await expect(page.getByText('Template published.')).toBeVisible()

  await page.goto(`/forms?templateId=${generatedForm.id}`)
  await page.getByLabel('Client').selectOption(client.id)
  await page.getByLabel('Template').selectOption(generatedForm.id)
  await page.getByLabel('Status').selectOption('submitted')
  await page.getByRole('button', { name: 'Create submission' }).click()
  await expect(page.getByText('Submission created.')).toBeVisible()

  const submissionsResponse = await apiFromPage(page, 'GET', '/api/forms/submissions', undefined, auth)
  expect(submissionsResponse.status).toBe(200)
  const submission = submissionsResponse.body.find(
    (entry) => entry.clientId === client.id && entry.templateId === generatedForm.id
  )
  expect(submission?.id).toBeTruthy()

  await page.goto(`/forms/submissions/${submission.id}`)
  await page.getByLabel('Client Name').fill('Document Flow')
  await page.getByLabel('Salary').fill('125000')
  await page.getByLabel('Started').fill('2026-04-21')
  await page.getByRole('button', { name: 'Save submission' }).click()
  await expect(page.getByText('Submission updated.')).toBeVisible()

  await page.goto('/exports')
  await page.getByTestId('create-export-template').selectOption(documentTemplate.id)
  await page.getByTestId('create-export-client').selectOption(client.id)
  await page.getByTestId('create-export-submission').selectOption(submission.id)
  await page.getByTestId('create-export-type').selectOption('pdf')
  await page.getByRole('button', { name: 'Queue export' }).click()
  await expect(page.getByText('PDF export queued.')).toBeVisible()
  await page.getByTestId('create-export-type').selectOption('xlsx')
  await page.getByRole('button', { name: 'Queue export' }).click()
  await expect(page.getByText('XLSX export queued.')).toBeVisible()

  await expect
    .poll(async () => {
      const response = await apiFromPage(page, 'GET', '/api/ops/exports/queue', undefined, auth)
      return response.body?.queue?.workerMode
    })
    .toBe('companion')

  await expect
    .poll(async () => {
      const response = await apiFromPage(page, 'GET', '/api/exports?sort=updatedAt_desc', undefined, auth)
      const matching = response.body.filter(
        (entry) => entry.templateId === documentTemplate.id && entry.clientId === client.id
      )
      return matching.filter((entry) => entry.status === 'completed' && entry.artifactAvailable === true).length
    })
    .toBeGreaterThanOrEqual(2)

  const exportsResponse = await apiFromPage(page, 'GET', '/api/exports?sort=updatedAt_desc', undefined, auth)
  const completedPdf = exportsResponse.body.find(
    (entry) => entry.templateId === documentTemplate.id && entry.type === 'pdf' && entry.status === 'completed'
  )
  const completedXlsx = exportsResponse.body.find(
    (entry) => entry.templateId === documentTemplate.id && entry.type === 'xlsx' && entry.status === 'completed'
  )
  expect(completedPdf?.output?.artifact?.renderer).toBe('pdf-lib-acroform')
  expect(completedXlsx?.output?.artifact?.renderer).toBe('structured-xlsx')

  const pdfDownload = await page.request.get(`/api/exports/${completedPdf.id}/download`)
  expect(pdfDownload.status()).toBe(200)
  expect(pdfDownload.headers()['content-type']).toBe('application/pdf')
  expect(pdfDownload.headers()['content-disposition']).toContain('.pdf')

  const xlsxDownload = await page.request.get(`/api/exports/${completedXlsx.id}/download`)
  expect(xlsxDownload.status()).toBe(200)
  expect(xlsxDownload.headers()['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  expect(xlsxDownload.headers()['content-disposition']).toContain('.xlsx')
})

test('routed app resolves direct deep links without falling back to legacy shell', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'deep-link-route')
  await signInFromUi(page, email, password)

  await page.goto('/admin/ops')
  await expect(page.getByRole('heading', { name: 'Ops' })).toBeVisible()
  await expect(page.locator('#login-form')).toHaveCount(0)

  await waitForAppReady(page, '/portal')
  await expect(page.getByRole('heading', { name: 'Portal' })).toBeVisible()
  await expect(page.locator('#portal-upload-form')).toHaveCount(0)
})
