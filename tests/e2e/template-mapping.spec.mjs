import { apiFromPage, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

// Not @release-blocking: exercises the source-path picker + auto-map flow that
// depends on GET /api/templates/:id/mapping-paths and
// POST /api/templates/:id/mappings/auto-map (merged alongside this UI).
test('template mapping picker shows grouped paths, saves a selection, and auto-map surfaces a toast', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'mapping-picker')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  // Seed a document template through the manual create endpoint (no PDF needed).
  const templateResponse = await apiFromPage(
    page,
    'POST',
    '/api/templates',
    {
      name: `Mapping Picker Template ${seededRunId}`,
      fileName: 'mapping-picker.pdf',
      extractedFields: ['clientName', 'householdName'],
      mappings: [
        { pdfField: 'clientName', fieldLabel: 'Client name', sourcePath: '', required: true },
        { pdfField: 'householdName', fieldLabel: 'Household name', sourcePath: '', required: false }
      ]
    },
    auth
  )
  expect(templateResponse.status).toBe(201)
  const documentTemplate = templateResponse.body

  await page.goto(`/templates/${documentTemplate.id}`)
  await expect(page.getByRole('heading', { name: 'Mappings' })).toBeVisible()

  // Both seeded fields start unmapped, so the badge reports them.
  await expect(page.getByTestId('unmapped-count-badge')).toHaveText('2 fields unmapped')

  // The picker opens with labeled group sections.
  const picker = page.getByRole('combobox', { name: 'Source path for householdName' })
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

  // Save mappings succeeds with the picked path.
  await page.getByRole('button', { name: 'Save mappings' }).click()
  await expect(page.getByText('Mappings saved.')).toBeVisible()
  await expect(page.getByTestId('unmapped-count-badge')).toHaveText('1 field unmapped')

  // Auto-map applies the returned template and surfaces a toast.
  await page.getByTestId('auto-map-button').click()
  await expect(page.getByTestId('toast')).toContainText(/Auto-mapped \d+ of \d+ fields/)
})
