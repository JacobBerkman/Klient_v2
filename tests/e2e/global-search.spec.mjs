import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

// Global search (Cmd/Ctrl+K) navigation. Deliberately NOT tagged
// @release-blocking: the feature has full unit coverage in
// apps/api/src/test/global-search.test.mjs; this spec covers the browser
// keyboard flow end to end.
test('Ctrl+K global search finds a seeded profile and Enter navigates to it', async ({ page, seededRunId }) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'gsearch')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Searchable',
      lastName: 'Persona',
      email: deterministicEmail(seededRunId, 'gsearch-profile')
    },
    auth
  )
  expect(prospectResponse.status, JSON.stringify(prospectResponse.body)).toBe(201)
  const profile = prospectResponse.body

  // Open the palette with the keyboard shortcut and type the seeded name.
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: 'Global search' })
  await expect(input).toBeVisible()
  await input.fill('Searchable Persona')

  // The debounced request populates the listbox with the profile option.
  const option = page.getByRole('option', { name: /Searchable Persona/ })
  await expect(option).toBeVisible()

  // Enter activates the highlighted option and navigates to the detail route.
  await input.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/profiles/${profile.id}$`))
})
