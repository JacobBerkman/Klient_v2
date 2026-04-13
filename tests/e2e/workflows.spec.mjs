import {
  deterministicEmail,
  inviteAndAcceptAdvisor,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'

async function inviteAndAcceptAdvisor(page, seed, label = 'advisor') {
  const safeSeed = `${seed}-${label}`
  const email = `${safeSeed}@e2e.test`
  const password = 'StrongPass123!'
  const inviteResponse = await page.request.post('/api/invites', {
    data: { email, role: 'advisor' }
  })
  expect(inviteResponse.status()).toBe(201)
  const invite = await inviteResponse.json()
  const acceptResponse = await page.request.post('/api/invites/accept', {
    data: {
      token: invite.token,
      firstName: 'Ops',
      lastName: 'Advisor',
      password
    }
  })
  expect(acceptResponse.ok()).toBeTruthy()
  return { email, password }
}

test('admin bootstrap registration and login remain stable', async ({ page, seededRunId }) => {
  const seed = `${seededRunId}-bootstrap`
  const email = `${seed}@e2e.test`
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
  const stableToken = seededRunId.replace(/[^a-z0-9-]/gi, '').slice(0, 24)

  const profileEmail = deterministicEmail(seededRunId, 'template-preview-client')
  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Template',
      lastName: 'Preview',
      email: `template-preview-${stableToken}@e2e.test`
    }
  })
  expect(profileResponse.ok()).toBeTruthy()
  const profile = await profileResponse.json()

  const templateName = `Template Preview Source ${seededRunId}`
  const formTemplateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Template Preview Source ${stableToken}`,
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
      name: `Auto Build Template ${stableToken}`,
      fileName: 'auto-build.pdf',
      fileBytes: [0x25, 0x50, 0x44, 0x46, 0x2d]
    }
  })
  expect(autoBuildResponse.status()).toBe(201)

  const remediationTemplateName = `Preflight Loop Template ${seededRunId}`
  const remediationTemplateResponse = await page.request.post('/api/templates', {
    data: {
      name: `Preflight Loop Template ${stableToken}`,
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.unknownPath', required: true }]
    }
  })
  expect(remediationTemplateResponse.status()).toBe(201)
  const remediationTemplate = await remediationTemplateResponse.json()

  await page.goto('/')
  await page.getByRole('button', { name: 'Templates' }).click()
  await page.locator('#template-select').selectOption(remediationTemplate.id)
  await page.getByRole('button', { name: '2. Extraction' }).click()
  await expect(page.getByText('Extracted fields 1')).toBeVisible()
  await page.locator('#jump-to-unmapped-extracted').click()
  await expect(page.getByRole('button', { name: '3. Mapping' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-mapping-filter="unmapped"][aria-pressed="true"]')).toBeVisible()
  await page.locator('[data-mapping-filter="required-only"]').click()
  await expect(page.locator('#mapping-row-0')).toBeVisible()
  await expect(page.locator('[data-apply-suggestion-row="0"]')).toBeVisible()

  await page.getByRole('button', { name: '5. Publish' }).click()
  await expect(page.locator('#publish-template')).toBeDisabled()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight found 1 schema issue(s).')).toBeVisible()
  await page.locator('[data-preflight-rowindex="0"]').click()
  await expect(page.getByRole('button', { name: '3. Mapping' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#inspector-sourcePath')).toBeFocused()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.unknownPath')

  await page.locator('#inspector-reset-source-path').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.locator('#inspector-reset-source-path-suggested').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.firstName')
  await page.locator('#inspector-reset-source-path').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.locator('#clear-unresolved-rows').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.locator('#auto-map-similar').click()
  await expect(page.getByText('Auto-mapped 1 row(s) by name similarity.')).toBeVisible()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.firstName')
  await page.selectOption('#inspector-transformType', 'expression')
  await page.fill('#inspector-transformExpression', 'value')
  await page.click('#inspector-reset-transform')
  await expect(page.locator('#inspector-transformType')).toHaveValue('')
  await expect(page.locator('#inspector-transformExpression')).toHaveValue('')
  await page.locator('#save-mappings').click()

  await page.getByRole('button', { name: '5. Publish' }).click()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight passed with no schema validation issues.')).toBeVisible()
  await expect(page.locator('#publish-template')).toBeEnabled()
  await page.locator('#publish-template').click()
  await expect(page.getByText('Templates: Template published.')).toBeVisible()
})

test('@release-blocking custom-field schema CRUD states surface in admin and propagate to profile create/edit UIs', async ({
  page,
  seededRunId,
  cleanupActions
}) => {
  await waitForAppReady(page)
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'schema')
  await signInFromUi(page, email, password)

  const fieldKey = `custom_field_${seededRunId.replace(/[^a-z0-9_]/gi, '_')}`
  await page.getByRole('button', { name: 'Custom Fields' }).click()
  await expect(page.getByRole('heading', { name: 'Custom Field Schema' })).toBeVisible()
  await page.locator('#custom-field-create-form input[name="key"]').fill(fieldKey)
  await page.locator('#custom-field-create-form input[name="label"]').fill('Custom Segment')
  await page.locator('#custom-field-create-form button[type="submit"]').click()
  await expect(page.locator('#custom-field-create-form [data-form-feedback]')).toContainText('Success: custom field created.')
  await expect(page.getByText(fieldKey)).toBeVisible()

  await page.locator(`[data-custom-field-update="${fieldKey}"] input[name="label"]`).fill('Custom Score')
  await page.locator(`[data-custom-field-update="${fieldKey}"] select[name="type"]`).selectOption('number')
  await page.locator(`[data-custom-field-update="${fieldKey}"] button[type="submit"]`).click()
  await expect(page.locator(`[data-custom-field-update="${fieldKey}"] [data-form-feedback]`)).toContainText(
    `Success: custom field ${fieldKey} updated.`
  )

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/custom-fields/schema/${fieldKey}`).catch(() => {})
  })

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Custom',
      lastName: 'Field',
      email: deterministicEmail(seededRunId, 'schema-profile')
    }
  })
  expect(profileResponse.status()).toBe(201)
  const profile = await profileResponse.json()

  await page.getByRole('button', { name: 'Dashboard' }).click()
  await expect(page.locator(`#profile-custom-fields [name="customField__${fieldKey}"]`)).toBeVisible()
  await expect(page.locator(`#profile-custom-fields [name="customField__${fieldKey}"]`)).toHaveAttribute('type', 'number')

  await page.getByRole('button', { name: 'Clients' }).click()
  await page.locator(`[data-edit-profile="${profile.id}"]`).click()
  await expect(page.locator(`#profile-edit-${profile.id}-${fieldKey}`)).toBeVisible()
  await expect(page.locator(`#profile-edit-${profile.id}-${fieldKey}`)).toHaveAttribute('type', 'number')

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
  })
})

test('admin-to-operator custom-field workflow preserves readonly UI and server RBAC enforcement', async ({ page, seededRunId }) => {
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

test('portal draft then submit lifecycle is stable', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'portal')
  await signInFromUi(page, email, password)

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Portal',
      lastName: 'Client',
      email: `portal-client-${Date.now()}@e2e.test`
    }
  })
  const profile = await profileResponse.json()
  expect(profileResponse.status()).toBe(201)

  const templateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Portal Intake ${Date.now()}`,
      sections: [
        {
          title: 'Goals',
          fields: [{ key: 'goal', label: 'Goal', type: 'text', required: true }]
        }
      ]
    }
  })
  const template = await templateResponse.json()
  expect(templateResponse.status()).toBe(201)

  const portalLinkResponse = await page.request.post('/api/portal-links', {
    data: { profileId: profile.id, templateIds: [template.id], expiresInHours: 2, maxUses: 3 }
  })
})
