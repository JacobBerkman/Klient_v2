import {
  applySecureCookieHeaderRouting,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect
} from './bootstrap.mjs'

async function createProfileFromUi(page, firstName, lastName) {
  await page.getByLabel('First name').fill(firstName)
  await page.getByLabel('Last name').fill(lastName)
  // The "Profile created." banner from an earlier submit can still be on screen, so a
  // text assertion alone could pass early; anchor on the 201 for THIS submission.
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/profiles' &&
      response.status() === 201
  )
  await page.getByRole('button', { name: 'Create profile' }).click()
  await created
  await expect(page.getByText('Profile created.')).toBeVisible()
}

test('multi-tab mutations recover from rotated CSRF tokens with a single transparent retry', async ({
  page,
  seededRunId
}) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'csrf-tabs')
  await signInFromUi(page, email, password)

  // Tab A performs a mutation so its in-memory CSRF token and the shared cookie agree.
  await page.goto('/profiles')
  await createProfileFromUi(page, 'TabA', 'First')

  // Tab B (same browser context = same session + CSRF cookie jar) performs a mutation.
  // Its CSRF bootstrap and mutation rotate the shared cookie/token binding, leaving
  // tab A holding a stale in-memory token.
  const pageB = await page.context().newPage()
  await applySecureCookieHeaderRouting(pageB)
  try {
    await pageB.goto('/profiles')
    await expect(pageB.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible()
    await createProfileFromUi(pageB, 'TabB', 'First')

    // Tab A mutates again with its stale token. The server rejects it pre-handler with
    // 403 CSRF_VALIDATION_FAILED, and the client must refresh + retry exactly once.
    const tabAProfilePostStatuses = []
    page.on('response', (response) => {
      if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/profiles') {
        tabAProfilePostStatuses.push(response.status())
      }
    })
    await createProfileFromUi(page, 'TabA', 'Second')

    // Prove the stale-token path was actually exercised: one pre-handler CSRF
    // rejection followed by exactly one successful retry, no retry loops.
    expect(tabAProfilePostStatuses).toEqual([403, 201])

    // Both tabs list all three profiles after a refresh; nothing was double-created.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible()
    await page.getByLabel('Search profiles').fill('TabA')
    await expect(page.getByText('TabA First')).toBeVisible()
    await expect(page.getByText('TabA Second')).toBeVisible()
    expect(await page.getByText('TabA Second').count()).toBe(1)
  } finally {
    await pageB.close()
  }
})
