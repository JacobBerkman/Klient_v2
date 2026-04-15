import {
  deterministicEmail,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect,
  waitForAppReady
} from './bootstrap.mjs'

async function inviteAndAcceptUser(page, seed, { label = 'advisor', role = 'advisor', firstName = 'Ops', lastName = 'Advisor' } = {}) {
  const safeSeed = `${seed}-${label}`
  const email = `${safeSeed}@e2e.test`
  const password = 'StrongPass123!'
  const inviteResponse = await page.request.post('/api/invites', {
    data: { email, role }
  })
  expect(inviteResponse.status()).toBe(201)
  const invite = await inviteResponse.json()
  const acceptResponse = await page.request.post('/api/invites/accept', {
    data: {
      token: invite.token,
      firstName,
      lastName,
      password
    }
  })
  expect(acceptResponse.ok()).toBeTruthy()
  return { email, password }
}

async function inviteAndAcceptAdvisor(page, seed, label = 'advisor') {
  return inviteAndAcceptUser(page, seed, { label, role: 'advisor' })
}

test('admin bootstrap registration and login remain stable', async ({ page, seededRunId }) => {
  const seed = `${seededRunId}-bootstrap`
  const email = `${seed}@e2e.test`
  const password = 'StrongPass123!'

  await page.goto('/legacy')
  await page.locator('#register-form input[name="firmName"]').fill(`Bootstrap Firm ${seededRunId}`)
  await page.locator('#register-form input[name="firstName"]').fill('Bootstrap')
  await page.locator('#register-form input[name="lastName"]').fill('Admin')
  await page.locator('#register-form input[name="email"]').fill(email)
  await page.locator('#register-form input[name="password"]').fill(password)
  await page.locator('#register-form button[type="submit"]').click()

  await expect(page.getByTestId('auth-status')).toContainText('Firm admin account created.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.request.post('/api/logout')
  await signInFromUi(page, email, password, '/legacy')
})

test('@release-blocking template upload/map/preflight/publish loop executes with issue remediation controls', async ({
  page,
  seededRunId,
  cleanupActions
}) => {
  await waitForAppReady(page, '/legacy')
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'template')
  await signInFromUi(page, email, password, '/legacy')
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
  const malformedAutoBuild = await autoBuildResponse.json()
  expect(malformedAutoBuild.extraction.status).toBe('failed')
  expect(malformedAutoBuild.extraction.reasonCode).toBe('malformed_pdf')
  expect(malformedAutoBuild.extraction.diagnostics[0].code).toBe('TEMPLATE_INGESTION_MALFORMED_PDF')

  const noFieldsResponse = await page.request.post('/api/templates/auto-build', {
    data: {
      name: `No Fields Auto Build ${stableToken}`,
      fileName: 'no-fields.pdf',
      fileBytes: Array.from(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /AcroForm 2 0 R >>\nendobj\n2 0 obj\n<< /Fields [] >>\nendobj\n%%EOF',
          'latin1'
        )
      )
    }
  })
  expect(noFieldsResponse.status()).toBe(201)
  const noFieldsAutoBuild = await noFieldsResponse.json()
  expect(noFieldsAutoBuild.extraction.reasonCode).toBe('no_fields')
  expect(noFieldsAutoBuild.extraction.error.code).toBe('TEMPLATE_INGESTION_NO_FIELDS')

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

  await page.goto('/legacy')
  await page.getByRole('button', { name: 'Templates' }).click()
  await page.locator('#template-select').selectOption(remediationTemplate.id)
  await page.getByRole('button', { name: '2. Extraction' }).click()
  await expect(page.getByText('Extracted fields 1')).toBeVisible()
  await page.locator('#jump-to-unmapped-extracted').click()
  await expect(page.getByRole('button', { name: '3. Mapping' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-mapping-filter="unmapped"][aria-pressed="true"]')).toBeVisible()
  await expect(page.getByText('No mappings match this filter.')).toBeVisible()
  await page.locator('[data-mapping-filter="unresolved-only"]').click()
  await expect(page.locator('#mapping-row-0')).toBeVisible()
  await page.locator('[data-mapping-filter="required-only"]').click()
  await expect(page.locator('#mapping-row-0')).toBeVisible()
  await expect(page.locator('[data-apply-suggestion-row="0"]')).toBeVisible()

  await page.getByRole('button', { name: '5. Publish' }).click()
  await expect(page.locator('#publish-template')).toBeDisabled()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight found 1 schema issue(s).')).toBeVisible()
  await page.getByRole('button', { name: '3. Mapping' }).click()
  await page.locator('[data-mapping-filter="unmapped"]').click()
  await page.locator('#mapping-search').fill('does-not-match-any-row')
  await expect(page.getByText('No mappings match this filter.')).toBeVisible()
  await page.getByRole('button', { name: '5. Publish' }).click()
  await page.locator('[data-preflight-rowindex="0"]').click()
  await expect(page.getByRole('button', { name: '3. Mapping' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-mapping-filter="all"][aria-pressed="true"]')).toBeVisible()
  await expect(page.locator('#mapping-search')).toHaveValue('')
  await expect(page.locator('#mapping-row-0')).toHaveClass(/is-jumped/)
  await expect(page.locator('#inspector-sourcePath')).toBeFocused()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.unknownPath')

  await page.locator('#inspector-reset-source-path').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.locator('#inspector-reset-source-path-suggested').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('profile.firstName')
  await page.locator('#inspector-reset-source-path').click()
  await expect(page.locator('#inspector-sourcePath')).toHaveValue('')
  await page.getByRole('button', { name: '5. Publish' }).click()
  await page.locator('#run-publish-preflight').click()
  await expect(page.getByText('Publish preflight found 1 schema issue(s).')).toBeVisible()
  await expect(page.getByText('required_source_path')).toBeVisible()
  await page.locator('[data-preflight-rowindex="0"]').click()
  await expect(page.locator('#inspector-sourcePath')).toBeFocused()
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
  await waitForAppReady(page, '/legacy')
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'schema')
  await signInFromUi(page, email, password, '/legacy')

  const fieldKey = `custom_field_${seededRunId.replace(/[^a-z0-9_]/gi, '_')}`
  await page.getByRole('button', { name: 'Custom Fields' }).click()
  await expect(page.getByRole('heading', { name: 'Custom Field Schema' })).toBeVisible()
  await page.locator('#custom-field-create-form input[name="key"]').fill(fieldKey)
  await page.locator('#custom-field-create-form input[name="label"]').fill('Custom Segment')
  await page.locator('#custom-field-create-form input[name="group"]').fill('Planning')
  await page.locator('#custom-field-create-form input[name="order"]').fill('20')
  await page.locator('#custom-field-create-form button[type="submit"]').click()
  await expect(page.locator('#custom-field-create-form [data-form-feedback]')).toContainText('Success: custom field created.')
  await expect(page.getByText(fieldKey)).toBeVisible()
  await expect(page.locator('table tbody tr').first()).toContainText('Planning')
  await expect(page.locator('table tbody tr').first()).toContainText('20')

  await page.locator('#custom-field-create-form input[name="key"]').fill(`invalid_${seededRunId}`)
  await page.locator('#custom-field-create-form input[name="order"]').fill('-5')
  await page.locator('#custom-field-create-form button[type="submit"]').click()
  await expect(page.locator('#custom-field-create-form [data-form-feedback]')).toContainText('Order must be a whole number 0 or higher.')

  await page.locator('#custom-field-bulk-add-row').click()
  const bulkRow = page.locator('[data-bulk-row]').last()
  await bulkRow.locator('input[name="bulkKey"]').fill(fieldKey)
  await bulkRow.locator('select[name="bulkType"]').selectOption('number')
  await bulkRow.locator('input[name="bulkLabel"]').fill('Custom Score')
  await bulkRow.locator('input[name="bulkRequired"]').fill('true')
  await bulkRow.locator('input[name="bulkGroup"]').fill('Board')
  await bulkRow.locator('input[name="bulkOrder"]').fill('5')
  await bulkRow.locator('input[name="bulkMetadata"]').fill('{"uiHint":"score"}')
  await page.locator('#custom-field-bulk-form button[type="submit"]').click()
  await expect(page.locator('#custom-field-bulk-form [data-form-feedback]')).toContainText(
    'Success: preview generated. Confirm to persist changes.'
  )
  await page.locator('#custom-field-bulk-confirm-form button[type="submit"]').click()
  await expect(page.getByText('Bulk schema changes saved.')).toBeVisible()

  await page.locator(`[data-custom-field-update="${fieldKey}"] input[name="label"]`).fill('Custom Score')
  await page.locator(`[data-custom-field-update="${fieldKey}"] select[name="type"]`).selectOption('number')
  await page.locator(`[data-custom-field-update="${fieldKey}"] input[name="group"]`).fill('Board')
  await page.locator(`[data-custom-field-update="${fieldKey}"] input[name="order"]`).fill('2')
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
  await expect(page.locator('#profile-custom-fields')).toContainText('Board')

  await page.getByRole('button', { name: 'Clients' }).click()
  await page.locator(`[data-edit-profile="${profile.id}"]`).click()
  await expect(page.locator(`#profile-edit-${profile.id}-${fieldKey}`)).toBeVisible()
  await expect(page.locator(`#profile-edit-${profile.id}-${fieldKey}`)).toHaveAttribute('type', 'number')

  await page.locator(`#profile-edit-${profile.id} input[name="firstName"]`).fill('CustomEdited')
  await page.request.patch(`/api/profiles/${profile.id}`, { data: { firstName: 'ServerChanged' } })
  await page.locator(`#profile-edit-${profile.id} button[type="submit"]`).click()
  await expect(page.locator(`[data-inline-feedback="${profile.id}"]`)).toContainText('Your unsaved edits were preserved')
  await expect(page.locator(`#profile-edit-${profile.id} input[name="firstName"]`)).toHaveValue('CustomEdited')
  await page.locator(`[data-inline-conflict-refresh="${profile.id}"]`).click()
  await expect(page.locator(`[data-inline-feedback="${profile.id}"]`)).toContainText('Reloaded latest server values')
  await expect(page.locator(`#profile-edit-${profile.id} input[name="firstName"]`)).toHaveValue('CustomEdited')

  cleanupActions.push(async () => {
    await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
  })
})

test('admin-to-operator custom-field workflow preserves readonly UI and server RBAC enforcement', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'admin-operator')
  await signInFromUi(page, email, password, '/legacy')

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
  await signInFromUi(page, advisorCredentials.email, advisorCredentials.password, '/legacy')

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

test('@release-blocking draft collaboration search/add/remove/refresh keeps RBAC boundaries explicit', async ({
  page,
  seededRunId,
  cleanupActions
}) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'draft-collab-admin')
  await signInFromUi(page, email, password, '/legacy')

  const advisor = await inviteAndAcceptUser(page, seededRunId, {
    label: 'draft-collab-advisor',
    role: 'advisor',
    firstName: 'Maya',
    lastName: 'Advisor'
  })
  const readonly = await inviteAndAcceptUser(page, seededRunId, {
    label: 'draft-collab-readonly',
    role: 'readonly',
    firstName: 'Rory',
    lastName: 'Readonly'
  })

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Collab',
      lastName: 'Owner',
      email: deterministicEmail(seededRunId, 'draft-collab-profile')
    }
  })
  expect(profileResponse.status()).toBe(201)
  const profile = await profileResponse.json()

  const templateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Collab Draft Template ${seededRunId}`,
      sections: [{ title: 'Basics', fields: [{ key: 'notes', label: 'Notes', type: 'text' }] }]
    }
  })
  expect(templateResponse.status()).toBe(201)
  const template = await templateResponse.json()

  const draftResponse = await page.request.post('/api/forms/submissions', {
    data: { clientId: profile.id, templateId: template.id, status: 'draft', data: { notes: 'Collab workflow' } }
  })
  expect(draftResponse.status()).toBe(201)
  const draft = await draftResponse.json()

  cleanupActions.push(async () => {
    await page.request.delete(`/api/forms/templates/${template.id}`).catch(() => {})
    await page.request.delete(`/api/profiles/${profile.id}`).catch(() => {})
  })

  await page.goto('/legacy')
  await page.getByRole('button', { name: 'Forms' }).click()
  await page.locator(`[data-open-draft-share-panel="${draft.id}"]`).click()
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toBeVisible()
  await expect(page.getByText('owner-manage')).toBeVisible()
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(
    'Current access state before any action: owner=yes, collaborator=yes, can-manage=yes.'
  )
  await expect(page.getByText('Changes use canonical user IDs')).toBeVisible()

  await page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] input[name="search"]`).fill('Maya')
  await page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] button[type="submit"]`).click()
  await expect(page.locator(`[data-draft-share-feedback="${draft.id}"]`)).toContainText('candidate user(s) ready to add')

  await page.locator(`form[data-add-draft-collaborator="${draft.id}"] select[name="userId"]`).selectOption({ label: /maya advisor/i })
  await page.locator(`form[data-add-draft-collaborator="${draft.id}"] button[type="submit"]`).click()
  await expect(page.locator(`[data-draft-share-feedback="${draft.id}"]`)).toContainText('added. Next: refresh membership if other sessions are active.')
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(advisor.email)

  const duplicateAddResponse = await page.request.post(`/api/forms/drafts/${draft.id}/collaborators`, {
    data: { userId: advisor.email }
  })
  expect(duplicateAddResponse.status()).toBe(409)
  const duplicateAddPayload = await duplicateAddResponse.json()
  expect(duplicateAddPayload.error.code).toBe('FORMS_DRAFT_COLLABORATORS_ALREADY_ADDED')

  await page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] input[name="search"]`).fill('Rory')
  await page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] button[type="submit"]`).click()
  await page.locator(`form[data-add-draft-collaborator="${draft.id}"] select[name="userId"]`).selectOption({ label: /rory readonly/i })
  const externalReadonlyAddResponse = await page.request.post(`/api/forms/drafts/${draft.id}/collaborators`, {
    data: { userId: readonly.email }
  })
  expect(externalReadonlyAddResponse.status()).toBe(201)
  await page.locator(`form[data-add-draft-collaborator="${draft.id}"] button[type="submit"]`).click()
  await expect(page.locator(`[data-draft-share-feedback="${draft.id}"]`)).toContainText(
    'That user is already a collaborator. Refresh membership to confirm the latest state.'
  )
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).not.toContainText(
    'Recovery: refresh membership first, then retry with the latest revision.'
  )

  await page.locator(`[data-refresh-draft-collaborators="${draft.id}"]`).click()
  await expect(page.locator(`[data-draft-share-feedback="${draft.id}"]`)).toContainText('membership refreshed')

  const readonlyRow = page.locator(`#draft-share-panel-${draft.id} li`, { hasText: readonly.email })
  await expect(readonlyRow).toBeVisible()
  await page.request.delete(`/api/forms/drafts/${draft.id}/collaborators/${readonly.email}`)
  await readonlyRow.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator(`[data-draft-share-feedback="${draft.id}"]`)).toContainText(
    'That collaborator was already removed. Refresh membership to sync with the latest server state.'
  )
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).not.toContainText(
    'Recovery: refresh membership first, then retry with the latest revision.'
  )

  const initialAdvisorRemoveResponse = await page.request.delete(`/api/forms/drafts/${draft.id}/collaborators/${advisor.email}`)
  expect([200, 204]).toContain(initialAdvisorRemoveResponse.status())
  const duplicateRemoveResponse = await page.request.delete(`/api/forms/drafts/${draft.id}/collaborators/${advisor.email}`)
  expect(duplicateRemoveResponse.status()).toBe(409)
  const duplicateRemovePayload = await duplicateRemoveResponse.json()
  expect(duplicateRemovePayload.error.code).toBe('FORMS_DRAFT_COLLABORATORS_ALREADY_REMOVED')

  await page.request.post('/api/logout')
  await signInFromUi(page, advisor.email, advisor.password, '/legacy')
  await page.getByRole('button', { name: 'Forms' }).click()
  await page.locator(`[data-open-draft-share-panel="${draft.id}"]`).click()
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(
    'Advisor access is view-only on drafts you do not own. Ask the draft owner (or an admin) to change collaborators.'
  )
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(
    'Current access state before any action: owner=no, collaborator=no, can-manage=no.'
  )
  await expect(page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] button[type="submit"]`)).toBeDisabled()
  await expect(page.locator(`form[data-add-draft-collaborator="${draft.id}"] button[type="submit"]`)).toBeDisabled()

  await page.request.post('/api/logout')
  await signInFromUi(page, readonly.email, readonly.password, '/legacy')
  await page.getByRole('button', { name: 'Forms' }).click()
  await page.locator(`[data-open-draft-share-panel="${draft.id}"]`).click()
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(
    'Readonly role: collaborator membership is visible, but add/remove actions are disabled.'
  )
  await expect(page.locator(`#draft-share-panel-${draft.id}`)).toContainText(
    'Current access state before any action: owner=no, collaborator=no, can-manage=no.'
  )
  await expect(page.locator(`form[data-search-draft-collaborator-users="${draft.id}"] button[type="submit"]`)).toBeDisabled()
  await expect(page.locator(`form[data-add-draft-collaborator="${draft.id}"] button[type="submit"]`)).toBeDisabled()

  const deniedAddResponse = await page.request.post(`/api/forms/drafts/${draft.id}/collaborators`, {
    data: { userId: advisor.email }
  })
  expect(deniedAddResponse.status()).toBe(403)
})

test('portal draft then submit lifecycle is stable', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'portal')
  await signInFromUi(page, email, password, '/legacy')
  const portalToken = seededRunId.replace(/[^a-z0-9-]/gi, '').slice(0, 24)

  const profileResponse = await page.request.post('/api/profiles', {
    data: {
      kind: 'client',
      firstName: 'Portal',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'portal-client')
    }
  })
  const profile = await profileResponse.json()
  expect(profileResponse.status()).toBe(201)

  const templateResponse = await page.request.post('/api/forms/templates', {
    data: {
      name: `Portal Intake ${portalToken}`,
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
