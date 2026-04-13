import {
  deterministicEmail,
  inviteAndAcceptAdvisor,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'

test('@release-blocking admin bootstrap registration and login remain stable', async ({ page, seededRunId }) => {
  await waitForAppReady(page)

  const email = deterministicEmail(seededRunId, 'bootstrap-admin')
  const password = 'StrongPass123!'

  await page.goto('/')
  await page.locator('#register-form input[name="firmName"]').fill(`Bootstrap Firm ${seededRunId}`)
  await page.locator('#register-form input[name="firstName"]').fill('Bootstrap')
  await page.locator('#register-form input[name="lastName"]').fill('Admin')
  await page.locator('#register-form input[name="email"]').fill(email)
  await page.locator('#register-form input[name="password"]').fill(password)
  await page.locator('#register-form button[type="submit"]').click()

  await expect(page.getByTestId('auth-status')).toContainText('Firm admin account created.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.request.post('/api/logout')
  await signInFromUi(page, email, password)
})

test('@release-blocking template upload/map/preflight/publish loop executes with issue remediation controls', async ({
  page,
  seededRunId,
  cleanupActions
}) => {
  await waitForAppReady(page)
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'template')
  await signInFromUi(page, email, password)

  const profileEmail = deterministicEmail(seededRunId, 'template-preview-client')
  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Template',
      lastName: 'Preview',
      email: profileEmail
    }
  })
  expect(profileResponse.ok()).toBeTruthy()
  const profile = await profileResponse.json()

  const templateName = `Template Preview Source ${seededRunId}`
  const formTemplateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: templateName,
      sections: [
        {
          title: 'Client goals',
          fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text', required: true }]
        }
      ]
    }
  })
  expect(formTemplateResponse.ok()).toBeTruthy()
  const formTemplate = await formTemplateResponse.json()

  cleanupActions.push(async () => {
    await page.request.delete(`/api/forms/templates/${formTemplate.id}`).catch(() => {})
    await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
  })

  const submissionResponse = await page.request.post('/api/forms/submissions', {
    data: {
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Retire at 55' }
    }
  })
  expect(submissionResponse.ok()).toBeTruthy()

  const autoBuildTemplateName = `Auto Build Template ${seededRunId}`
  const autoBuildResponse = await page.request.post('/api/templates/auto-build', {
    data: {
      name: autoBuildTemplateName,
      fileName: 'auto-build.pdf',
      fileBytes: [0x25, 0x50, 0x44, 0x46, 0x2d]
    }
  })
  expect(autoBuildResponse.status()).toBe(201)

  const remediationTemplateName = `Preflight Loop Template ${seededRunId}`
  const remediationTemplateResponse = await page.request.post('/api/templates', {
    data: {
      name: remediationTemplateName,
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.unknownPath', required: true }]
    }
  })
  expect(remediationTemplateResponse.status()).toBe(201)
  const remediationTemplate = await remediationTemplateResponse.json()

  await page.goto('/')
  await page.getByRole('button', { name: 'Templates' }).click()
  await page.locator('#template-select').selectOption(remediationTemplate.id)
  await page.getByRole('button', { name: '3. Mapping' }).click()
  await page.locator('[data-mapping-filter="required-only"]').click()
  await expect(page.locator('#mapping-row-0')).toBeVisible()

  await page.getByRole('button', { name: '5. Publish' }).click()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight found 1 schema issue(s).')).toBeVisible()
  await page.locator('[data-preflight-rowindex="0"]').click()
  await expect(page.locator('#inspector-sourcePath')).toBeFocused()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.unknownPath')

  await page.getByRole('button', { name: '3. Mapping' }).click()
  await page.locator('#clear-unresolved-rows').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.locator('#auto-map-similar').click()
  await expect(page.getByText('Auto-mapped 1 row(s) by name similarity.')).toBeVisible()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.firstName')
  await page.locator('#save-mappings').click()

  await page.getByRole('button', { name: '5. Publish' }).click()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight passed with no schema validation issues.')).toBeVisible()
  await page.locator('#publish-template').click()
  await expect(page.getByText('Templates: Template published.')).toBeVisible()
})

test('@release-blocking custom-field schema CRUD supports profile usage paths', async ({ page, seededRunId, cleanupActions }) => {
  await waitForAppReady(page)
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'schema')
  await signInFromUi(page, email, password)

  const fieldKey = `custom-field-${seededRunId}`
  const createResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: {
      key: fieldKey,
      type: 'text',
      label: 'Custom Segment',
      required: true
    }
  })
  expect(createResponse.status()).toBe(201)

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/custom-fields/schema/${fieldKey}`).catch(() => {})
  })

  const updateResponse = await page.request.patch(`/api/profiles/custom-fields/schema/${fieldKey}`, {
    data: { required: false, metadata: { category: 'household' } }
  })
  expect(updateResponse.ok()).toBeTruthy()

  const schemaResponse = await page.request.get('/api/profiles/custom-fields/schema')
  expect(schemaResponse.ok()).toBeTruthy()
  const schema = await schemaResponse.json()
  const updatedField = schema.fields.find((field) => field.key === fieldKey)
  expect(updatedField).toBeTruthy()
  expect(updatedField.required).toBe(false)

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Custom',
      lastName: 'Field',
      extensions: {
        schemaVersion: '1.0.0',
        schema: { properties: { [fieldKey]: { type: 'string' } } },
        values: { [fieldKey]: 'Platinum segment' }
      }
    }
  })
  expect(profileResponse.status()).toBe(201)
  const profile = await profileResponse.json()
  expect(profile.extensions?.values?.[fieldKey]).toBe('Platinum segment')

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
  })
})

test('@release-blocking admin-to-operator custom-field workflow preserves readonly UI and server RBAC enforcement', async ({
  page,
  seededRunId,
  cleanupActions
}) => {
  await waitForAppReady(page)
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'admin-operator')
  await signInFromUi(page, email, password)

  const fieldKey = `workflow-field-${seededRunId}`
  const createResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: {
      key: fieldKey,
      type: 'number',
      label: 'Workflow Score',
      metadata: { group: 'workflow' }
    }
  })
  expect(createResponse.status()).toBe(201)

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/custom-fields/schema/${fieldKey}`).catch(() => {})
  })

  const advisorCredentials = await inviteAndAcceptAdvisor(page, seededRunId, 'operator')
  await page.request.post('/api/logout')
  await signInFromUi(page, advisorCredentials.email, advisorCredentials.password)

  await page.getByRole('button', { name: 'Custom Fields' }).click()
  await expect(page.getByRole('heading', { name: 'Custom Field Schema' })).toBeVisible()
  await expect(page.getByText('Advisor role is read-only for schema changes')).toBeVisible()
  await expect(page.locator('#custom-field-create-form button[type="submit"]')).toBeDisabled()
  await expect(page.getByText(fieldKey)).toBeVisible()

  const blockedCreateResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: { key: `blocked-${seededRunId}`, type: 'text' }
  })
  expect(blockedCreateResponse.status()).toBe(403)
})

test.describe('transient infrastructure retries', () => {
  test.describe.configure({ retries: process.env.CI ? 1 : 0 })

  test('@release-blocking @transient-infra portal draft then submit lifecycle is stable', async ({ page, seededRunId, cleanupActions }) => {
    await waitForAppReady(page)
    const { email, password } = await registerAdminViaApi(page, seededRunId, 'portal')
    await signInFromUi(page, email, password)

    const profileEmail = deterministicEmail(seededRunId, 'portal-client')
    const profileResponse = await page.request.post('/api/profiles', {
      data: {
        kind: 'client',
        firstName: 'Portal',
        lastName: 'Client',
        email: profileEmail
      }
    })
    expect(profileResponse.status()).toBe(201)
    const profile = await profileResponse.json()

    const templateResponse = await page.request.post('/api/forms/templates', {
      data: {
        name: `Portal Intake ${seededRunId}`,
        sections: [
          {
            title: 'Goals',
            fields: [{ key: 'goal', label: 'Goal', type: 'text', required: true }]
          }
        ]
      }
    })
    expect(templateResponse.status()).toBe(201)
    const template = await templateResponse.json()

    cleanupActions.push(async () => {
      await page.request.delete(`/api/forms/templates/${template.id}`).catch(() => {})
      await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
    })

    const portalLinkResponse = await page.request.post('/api/portal-links', {
      data: { profileId: profile.id, templateIds: [template.id], expiresInHours: 2, maxUses: 3 }
    })
    expect(portalLinkResponse.status()).toBe(201)
    const portalLink = await portalLinkResponse.json()

    await page.goto(`/portal.html?token=${portalLink.token}`)
    await expect(page.getByTestId('template-picker')).toBeVisible()

    await page.locator('#portal-fields input[name="goal"]').fill('Save for retirement')
    await page.getByTestId('portal-save-draft').click()
    await expect(page.getByTestId('portal-status-badge')).toContainText('draft')

    await page.getByTestId('portal-submit').click()
    await expect(page.getByTestId('portal-status-badge')).toContainText('submitted')
  })
})
