import {
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

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.getByRole('button', { name: 'Sign out' }).click()
  await signInFromUi(page, email, password)
})

test('@release-blocking routed navigation reaches every advertised backoffice route', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'nav')
  await signInFromUi(page, email, password)

  await page.getByRole('link', { name: 'Pipeline' }).click()
  await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible()

  await page.getByRole('link', { name: 'Profiles' }).click()
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible()

  await page.getByRole('link', { name: 'Households' }).click()
  await expect(page.getByRole('heading', { name: 'Households' })).toBeVisible()

  await page.getByRole('link', { name: 'Forms' }).click()
  await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible()

  await page.getByRole('link', { name: 'Templates' }).click()
  await expect(page.getByRole('heading', { name: 'Templates' })).toBeVisible()

  await page.getByRole('link', { name: 'Exports' }).click()
  await expect(page.getByRole('heading', { name: 'Exports' })).toBeVisible()

  await page.getByRole('link', { name: 'Analytics' }).click()
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()

  await page.getByRole('link', { name: 'Audit' }).click()
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible()

  await page.getByRole('link', { name: 'Ops' }).click()
  await expect(page.getByRole('heading', { name: 'Ops' })).toBeVisible()
})

test('@release-blocking profile and submission detail routes open as shareable URLs', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'details')

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Detail',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'detail-client')
    }
  })
  expect(profileResponse.status()).toBe(201)
  const profile = await profileResponse.json()

  const formTemplateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Detail Form ${seededRunId}`,
      sections: [
        {
          title: 'Basics',
          fields: [{ key: 'goal', label: 'Goal', type: 'text', required: true }]
        }
      ]
    }
  })
  expect(formTemplateResponse.status()).toBe(201)
  const template = await formTemplateResponse.json()

  const submissionResponse = await page.request.post('/api/forms/submissions', {
    data: {
      clientId: profile.id,
      templateId: template.id,
      status: 'draft',
      data: { goal: 'Retire early' }
    }
  })
  expect(submissionResponse.status()).toBe(201)
  const submission = await submissionResponse.json()

  await signInFromUi(page, email, password)

  await page.goto('/profiles')
  await page.getByTestId(`profile-link-${profile.id}`).click()
  await expect(page).toHaveURL(new RegExp(`/profiles/${profile.id}$`))
  await expect(page.getByText('Editable details')).toBeVisible()

  await page.goto(`/forms/submissions/${submission.id}`)
  await expect(page.getByRole('heading', { name: new RegExp(template.name) })).toBeVisible()
  await expect(page.getByText('Collaborators')).toBeVisible()
})

test('@release-blocking stage movement and export download work in the routed product shell', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'pipeline-export')

  const stagesResponse = await page.request.get('/api/pipeline/stages')
  expect(stagesResponse.ok()).toBeTruthy()
  const stages = await stagesResponse.json()
  const firstStage = stages[0]?.id
  const targetStage = stages[1]?.id || stages[0]?.id

  const prospectResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'prospect',
      stage: firstStage,
      firstName: 'Pipeline',
      lastName: 'Prospect',
      email: deterministicEmail(seededRunId, 'pipeline-prospect')
    }
  })
  expect(prospectResponse.status()).toBe(201)
  const prospect = await prospectResponse.json()

  const clientResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Export',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'export-client')
    }
  })
  expect(clientResponse.status()).toBe(201)
  const client = await clientResponse.json()

  const documentTemplateResponse = await page.request.post('/api/templates', {
    data: {
      name: `Export Template ${seededRunId}`,
      fileName: 'export-template.pdf',
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.firstName', required: true }]
    }
  })
  expect(documentTemplateResponse.status()).toBe(201)
  const documentTemplate = await documentTemplateResponse.json()

  await signInFromUi(page, email, password)

  await page.goto('/pipeline')
  await expect(page.getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  const stageSelect = page.getByTestId(`pipeline-card-${prospect.id}`).getByRole('combobox')
  await stageSelect.selectOption(targetStage)
  await expect(page.getByText(`Moved to ${targetStage}.`)).toBeVisible()

  await page.goto('/exports')
  await page.getByLabel('Template').selectOption(documentTemplate.id)
  await page.getByLabel('Client').selectOption(client.id)
  await page.getByTestId('create-export-submit').click()
  await expect(page.getByText('Export queued.')).toBeVisible()

  await page.getByRole('button', { name: 'Process queue now' }).click()
  await expect(page.getByText('Queued export processing triggered.')).toBeVisible()

  const downloadLink = page.getByRole('link', { name: 'Download' }).first()
  await expect(downloadLink).toBeVisible()
  const download = await page.waitForEvent('download', async () => {
    await downloadLink.click()
  })
  await expect(download.suggestedFilename()).toBeTruthy()
})
