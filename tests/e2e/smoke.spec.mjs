import {
  apiFromPage,
  deterministicEmail,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'

test('@release-blocking register and login routes work in the routed shell', async ({ page, seededRunId }) => {
  const email = deterministicEmail(seededRunId, 'register-smoke')
  const password = 'StrongPass123!'

  await waitForAppReady(page)
  await page.goto('/register')
  await page.getByRole('textbox', { name: 'Firm name' }).fill(`Smoke Firm ${seededRunId}`)
  await page.getByRole('textbox', { name: 'First name' }).fill('Smoke')
  await page.getByRole('textbox', { name: 'Last name' }).fill('Admin')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible()
  await expect(page.getByText('Firm overview')).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('login-form')).toBeVisible()
  await page.context().clearCookies()
  await signInFromUi(page, email, password)
})

test('@release-blocking routed navigation reaches every advertised backoffice route', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'nav')
  await signInFromUi(page, email, password)

  await page.getByRole('link', { name: 'Pipeline', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()
  await expect(page.getByRole('search', { name: 'Pipeline filters' })).toBeVisible()

  await page.getByRole('link', { name: 'Profiles', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Profiles panel' })).toBeVisible()

  await page.getByRole('link', { name: 'Households', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Households' })).toBeVisible()
  await expect(page.getByText('Keep relationships organized')).toBeVisible()

  await page.getByRole('link', { name: 'Forms', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible()
  await expect(page.getByText('Collect, review, and collaborate from one route')).toBeVisible()

  await page.getByRole('link', { name: 'Templates', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Templates', level: 2 })).toBeVisible()
  await expect(page.getByText('Template library')).toBeVisible()

  await page.getByRole('link', { name: 'Exports', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible()
  await expect(page.getByText('Queue, monitor, retry, and download deliverables')).toBeVisible()

  await page.getByRole('link', { name: 'Analytics', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await expect(page.getByRole('search', { name: 'Analytics filters' })).toBeVisible()

  await page.getByRole('link', { name: 'Audit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Audit', exact: true })).toBeVisible()
  await expect(page.getByRole('search', { name: 'Audit search' })).toBeVisible()

  await page.getByRole('link', { name: 'Ops' }).click()
  await expect(page.getByRole('heading', { name: 'Ops' })).toBeVisible()
  await expect(page.getByText('Release and runtime signals in one place')).toBeVisible()
})

test('@release-blocking profile and submission detail routes open as shareable URLs', async ({ page, seededRunId }) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'details')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const profileResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Detail',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'detail-client')
    },
    auth
  )
  expect(profileResponse.status, JSON.stringify(profileResponse.body)).toBe(201)
  const profile = profileResponse.body

  const formTemplateResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/templates',
    {
      name: `Detail Form ${seededRunId}`,
      sections: [
        {
          title: 'Basics',
          fields: [{ key: 'goal', label: 'Goal', type: 'text', required: true }]
        }
      ]
    },
    auth
  )
  expect(formTemplateResponse.status).toBe(201)
  const template = formTemplateResponse.body

  const submissionResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/submissions',
    {
      clientId: profile.id,
      templateId: template.id,
      status: 'draft',
      data: { goal: 'Retire early' }
    },
    auth
  )
  expect(submissionResponse.status).toBe(201)
  const submission = submissionResponse.body

  await page.goto('/profiles')
  await page.getByTestId(`profile-link-${profile.id}`).click()
  await expect(page).toHaveURL(new RegExp(`/profiles/${profile.id}$`))
  await expect(page.getByText('Editable details')).toBeVisible()

  await page.goto(`/forms/submissions/${submission.id}`)
  await expect(page.getByRole('heading', { name: new RegExp(template.name) })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Collaborators' })).toBeVisible()
})

test('@release-blocking stage movement and export download work in the routed product shell', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'pipeline-export')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const stages = boardResponse.body.stages || []
  const firstStage = stages[0]?.id
  const targetStage = stages[1]?.id || stages[0]?.id

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage: firstStage,
      firstName: 'Pipeline',
      lastName: 'Prospect',
      email: deterministicEmail(seededRunId, 'pipeline-prospect')
    },
    auth
  )
  expect(prospectResponse.status).toBe(201)
  const prospect = prospectResponse.body

  const clientResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Export',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'export-client')
    },
    auth
  )
  expect(clientResponse.status).toBe(201)
  const client = clientResponse.body

  const documentTemplateResponse = await apiFromPage(
    page,
    'POST',
    '/api/templates',
    {
      name: `Export Template ${seededRunId}`,
      fileName: 'export-template.pdf',
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.firstName', required: true }]
    },
    auth
  )
  expect(documentTemplateResponse.status).toBe(201)
  const documentTemplate = documentTemplateResponse.body

  await page.goto('/pipeline')
  await expect(page.getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  const stageSelect = page.getByTestId(`pipeline-card-${prospect.id}`).getByRole('combobox')
  await stageSelect.selectOption(targetStage)
  await expect(page.getByText(`Moved to ${targetStage}.`)).toBeVisible()

  await page.goto('/exports')
  await page.getByLabel('Template').selectOption(documentTemplate.id)
  await page.getByLabel('Client').first().selectOption(client.id)
  await page.getByTestId('create-export-submit').click()
  await expect(page.getByText('Export queued.')).toBeVisible()

  await expect(page.getByText('Queued, waiting for worker').first()).toBeVisible()
  await expect
    .poll(
      async () => {
        const response = await apiFromPage(page, 'GET', '/api/exports?sort=updatedAt_desc', undefined, auth)
        const job = response.body.find((entry) => entry.templateId === documentTemplate.id)
        return job?.status || 'missing'
      },
      { timeout: 15_000 }
    )
    .toBe('completed')
  await page.reload()

  const downloadLink = page.getByRole('link', { name: 'Download' }).first()
  await expect(downloadLink).toBeVisible({ timeout: 15_000 })
  const downloadHref = await downloadLink.getAttribute('href')
  expect(downloadHref).toBeTruthy()
  const downloadResponse = await page.request.get(downloadHref)
  expect(downloadResponse.ok()).toBeTruthy()
  expect(downloadResponse.headers()['content-disposition'] || '').toContain('attachment')
})
