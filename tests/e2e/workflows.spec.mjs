import { test, expect } from '@playwright/test'

function uniqueSeed(testInfo, label) {
  const slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `${slug}-${label}-${Date.now()}`
}

async function registerAdmin(page, testInfo, label = 'admin') {
  const seed = uniqueSeed(testInfo, label)
  const email = `${seed}@e2e.test`
  const password = 'StrongPass123!'
  const response = await page.request.post('/api/register', {
    data: {
      firmName: `E2E Firm ${seed}`,
      firstName: 'E2E',
      lastName: 'Admin',
      email,
      password
    }
  })
  expect(response.ok()).toBeTruthy()
  return { email, password }
}

async function signInFromUi(page, email, password) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.locator('[data-e2e="login-submit"]').click()
  await expect(page.locator('[data-e2e="auth-status"]')).toContainText('Signed in successfully.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

async function inviteAndAcceptAdvisor(page, testInfo, label = 'advisor') {
  const seed = uniqueSeed(testInfo, label)
  const email = `${seed}@e2e.test`
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

test('admin bootstrap registration and login remain stable', async ({ page }, testInfo) => {
  const seed = uniqueSeed(testInfo, 'bootstrap')
  const email = `${seed}@e2e.test`
  const password = 'StrongPass123!'

  await page.goto('/')
  await page.locator('#register-form input[name="firmName"]').fill(`Bootstrap Firm ${seed}`)
  await page.locator('#register-form input[name="firstName"]').fill('Bootstrap')
  await page.locator('#register-form input[name="lastName"]').fill('Admin')
  await page.locator('#register-form input[name="email"]').fill(email)
  await page.locator('#register-form input[name="password"]').fill(password)
  await page.locator('#register-form button[type="submit"]').click()

  await expect(page.locator('[data-e2e="auth-status"]')).toContainText('Firm admin account created.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.request.post('/api/logout')
  await signInFromUi(page, email, password)
})

test('template upload/map/preflight/publish loop executes with issue remediation controls', async ({ page }, testInfo) => {
  const { email, password } = await registerAdmin(page, testInfo, 'template')
  await signInFromUi(page, email, password)

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Template',
      lastName: 'Preview',
      email: `template-preview-${Date.now()}@e2e.test`
    }
  })
  const profile = await profileResponse.json()
  expect(profileResponse.ok()).toBeTruthy()

  const formTemplateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Template Preview Source ${Date.now()}`,
      sections: [
        {
          title: 'Client goals',
          fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text', required: true }]
        }
      ]
    }
  })
  const formTemplate = await formTemplateResponse.json()
  expect(formTemplateResponse.ok()).toBeTruthy()

  const submissionResponse = await page.request.post('/api/forms/submissions', {
    data: {
      clientId: profile.id,
      templateId: formTemplate.id,
      status: 'submitted',
      data: { primaryGoal: 'Retire at 55' }
    }
  })
  expect(submissionResponse.ok()).toBeTruthy()

  const autoBuildResponse = await page.request.post('/api/templates/auto-build', {
    data: {
      name: `Auto Build Template ${Date.now()}`,
      fileName: 'auto-build.pdf',
      fileBytes: [0x25, 0x50, 0x44, 0x46, 0x2d]
    }
  })
  const autoBuiltTemplate = await autoBuildResponse.json()
  expect(autoBuildResponse.status()).toBe(201)
  expect(autoBuiltTemplate.id).toBeTruthy()

  const remediationTemplateResponse = await page.request.post('/api/templates', {
    data: {
      name: `Preflight Loop Template ${Date.now()}`,
      extractedFields: ['firstName'],
      mappings: [{ pdfField: 'firstName', fieldLabel: 'First Name', sourcePath: 'profile.unknownPath', required: true }]
    }
  })
  const remediationTemplate = await remediationTemplateResponse.json()
  expect(remediationTemplateResponse.status()).toBe(201)

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

test('custom-field schema CRUD supports profile usage paths', async ({ page }, testInfo) => {
  const { email, password } = await registerAdmin(page, testInfo, 'schema')
  await signInFromUi(page, email, password)

  const fieldKey = `custom_field_${Date.now()}`
  const createResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: {
      key: fieldKey,
      type: 'text',
      label: 'Custom Segment',
      required: true
    }
  })
  expect(createResponse.status()).toBe(201)

  const updateResponse = await page.request.patch(`/api/profiles/custom-fields/schema/${fieldKey}`, {
    data: { required: false, metadata: { category: 'household' } }
  })
  expect(updateResponse.ok()).toBeTruthy()

  const schemaResponse = await page.request.get('/api/profiles/custom-fields/schema')
  const schema = await schemaResponse.json()
  expect(schemaResponse.ok()).toBeTruthy()
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
  const profile = await profileResponse.json()
  expect(profileResponse.status()).toBe(201)
  expect(profile.extensions?.values?.[fieldKey]).toBe('Platinum segment')

  const deleteResponse = await page.request.delete(`/api/profiles/custom-fields/schema/${fieldKey}`)
  expect(deleteResponse.ok()).toBeTruthy()
})

test('admin-to-operator custom-field workflow preserves readonly UI and server RBAC enforcement', async ({ page }, testInfo) => {
  const { email, password } = await registerAdmin(page, testInfo, 'admin-operator')
  await signInFromUi(page, email, password)
  const fieldKey = `workflow_field_${Date.now()}`
  const createResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: {
      key: fieldKey,
      type: 'number',
      label: 'Workflow Score',
      metadata: { group: 'workflow' }
    }
  })
  expect(createResponse.status()).toBe(201)

  const advisorCredentials = await inviteAndAcceptAdvisor(page, testInfo, 'operator')
  await page.request.post('/api/logout')
  await signInFromUi(page, advisorCredentials.email, advisorCredentials.password)

  await page.getByRole('button', { name: 'Custom Fields' }).click()
  await expect(page.getByRole('heading', { name: 'Custom Field Schema' })).toBeVisible()
  await expect(page.getByText('Advisor role is read-only for schema changes')).toBeVisible()
  await expect(page.locator('#custom-field-create-form button[type="submit"]')).toBeDisabled()
  await expect(page.getByText(fieldKey)).toBeVisible()

  const blockedCreateResponse = await page.request.post('/api/profiles/custom-fields/schema', {
    data: { key: `blocked_${Date.now()}`, type: 'text' }
  })
  expect(blockedCreateResponse.status()).toBe(403)
})

test('portal draft then submit lifecycle is stable', async ({ page }, testInfo) => {
  const { email, password } = await registerAdmin(page, testInfo, 'portal')
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
  const portalLink = await portalLinkResponse.json()
  expect(portalLinkResponse.status()).toBe(201)

  await page.goto(`/portal.html?token=${portalLink.token}`)
  await expect(page.locator('[data-e2e="template-picker"]')).toBeVisible()

  await page.locator('#portal-fields input[name="goal"]').fill('Save for retirement')
  await page.locator('[data-e2e="portal-save-draft"]').click()
  await expect(page.locator('[data-e2e="portal-status-badge"]')).toContainText('draft')

  await page.locator('[data-e2e="portal-submit"]').click()
  await expect(page.locator('[data-e2e="portal-status-badge"]')).toContainText('submitted')
})
