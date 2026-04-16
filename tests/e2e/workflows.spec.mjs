import {
  apiFromPage,
  deterministicEmail,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'

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
