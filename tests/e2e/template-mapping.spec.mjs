import { apiFromPage, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

// Not @release-blocking: exercises the source-path picker + auto-map flow that
// depends on GET /api/templates/:id/mapping-paths and
// POST /api/templates/:id/mappings/auto-map (merged alongside this UI).
test('template mapping picker shows grouped paths, auto-map applies heuristics, and manual picks save', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'mapping-picker')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  // Seed a document template through the manual create endpoint (no PDF
  // needed). Both rows carry the snake_case auto-build placeholder key, which
  // the UI counts as unmapped. householdName matches the auto-map heuristics;
  // misc_reference_code deliberately matches nothing.
  const templateResponse = await apiFromPage(
    page,
    'POST',
    '/api/templates',
    {
      name: `Mapping Picker Template ${seededRunId}`,
      fileName: 'mapping-picker.pdf',
      extractedFields: ['householdName', 'misc_reference_code'],
      mappings: [
        { pdfField: 'householdName', fieldLabel: 'Household name', sourcePath: 'household_name', required: false },
        {
          pdfField: 'misc_reference_code',
          fieldLabel: 'Reference code',
          sourcePath: 'misc_reference_code',
          required: false
        }
      ]
    },
    auth
  )
  expect(templateResponse.status, JSON.stringify(templateResponse.body)).toBe(201)
  const documentTemplate = templateResponse.body

  await page.goto(`/templates/${documentTemplate.id}`)
  await expect(page.getByRole('heading', { name: 'Mappings' })).toBeVisible()

  // Both rows still echo their auto-build placeholder keys, so both count as
  // unmapped.
  await expect(page.getByTestId('unmapped-count-badge')).toHaveText('2 fields unmapped')

  // Auto-map applies the household heuristic to householdName, leaves the
  // reference code untouched, and surfaces a toast in the notifications live
  // region (same pattern as theme-and-toasts.spec.mjs).
  await page.getByTestId('auto-map-button').click()
  const notifications = page.getByRole('region', { name: 'Notifications' })
  const toast = notifications.getByRole('status').filter({ hasText: 'Auto-mapped 1 of 2 fields' })
  await expect(toast).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Source path for householdName' })).toHaveValue('household.name')
  await expect(page.getByTestId('unmapped-count-badge')).toHaveText('1 field unmapped')

  // The picker opens with labeled group sections for the remaining field.
  const picker = page.getByRole('combobox', { name: 'Source path for misc_reference_code' })
  await picker.click()
  const listbox = page.getByTestId('source-path-listbox')
  await expect(listbox).toBeVisible()
  await expect(listbox.getByRole('group', { name: 'Client profile' })).toBeVisible()
  await expect(listbox.getByRole('group', { name: 'Household' })).toBeVisible()

  // Select a household path for the field.
  const householdOption = listbox.getByRole('group', { name: 'Household' }).getByRole('option').first()
  const selectedPath = await householdOption.getAttribute('data-path')
  expect(selectedPath).toBeTruthy()
  await householdOption.click()
  await expect(listbox).toHaveCount(0)
  await expect(picker).toHaveValue(String(selectedPath))

  // Save mappings succeeds with the picked path and everything reads mapped.
  await page.getByRole('button', { name: 'Save mappings' }).click()
  await expect(page.getByText('Mappings saved.')).toBeVisible()
  await expect(page.getByTestId('unmapped-count-badge')).toHaveText('all fields mapped')

  // The record fallback is a first-class, editable column: it fills the field
  // from firm records only when the primary source resolves to nothing.
  const fallbackPicker = page.getByRole('combobox', { name: 'Record fallback for misc_reference_code' })
  await fallbackPicker.click()
  const fallbackListbox = page.getByTestId('source-path-listbox')
  const profileOption = fallbackListbox.getByRole('group', { name: 'Client profile' }).getByRole('option').first()
  const fallbackPath = await profileOption.getAttribute('data-path')
  await profileOption.click()
  await expect(fallbackPicker).toHaveValue(String(fallbackPath))

  await page.getByRole('button', { name: 'Save mappings' }).click()
  await expect(page.getByText('Mappings saved.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Record fallback for misc_reference_code' })).toHaveValue(
    String(fallbackPath)
  )
})
