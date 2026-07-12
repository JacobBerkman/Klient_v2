import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('@release-blocking client archives from detail, drops out of the list, and restores', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'archive-client')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const clientResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Archivable',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'archive-client-profile')
    },
    auth
  )
  expect(clientResponse.status, JSON.stringify(clientResponse.body)).toBe(201)
  const client = clientResponse.body

  await page.goto(`/profiles/${client.id}`)
  const archivePanel = page.getByTestId('profile-archive')
  await archivePanel.getByRole('button', { name: 'Archive profile' }).click()
  await expect(archivePanel.getByText(/Archiving hides this client/)).toBeVisible()
  await archivePanel.getByRole('button', { name: 'Confirm archive' }).click()

  await expect(page.getByText('Profile archived.')).toBeVisible()
  await expect(page.getByTestId('profile-archived-banner')).toBeVisible()

  // Excluded from the default (non-archived) profiles list.
  await page.goto('/profiles')
  await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible()
  await expect(page.getByTestId(`profile-link-${client.id}`)).toHaveCount(0)

  // Restore from the archived banner (detail route still resolves an archived profile).
  await page.goto(`/profiles/${client.id}`)
  await page.getByTestId('profile-restore').click()
  await expect(page.getByText('Profile restored.')).toBeVisible()
  await expect(page.getByTestId('profile-archived-banner')).toHaveCount(0)

  // Back in the default list once restored.
  await page.goto('/profiles')
  await expect(page.getByTestId(`profile-link-${client.id}`)).toBeVisible()
})

test('@release-blocking archiving a prospect removes it from the board and dashboard count, restore returns it', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'archive-prospect')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const stage = boardResponse.body.stages.filter((entry) => entry.active)[0].id

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage,
      firstName: 'Archivable',
      lastName: 'Prospect',
      email: deterministicEmail(seededRunId, 'archive-prospect-profile')
    },
    auth
  )
  expect(prospectResponse.status).toBe(201)
  const prospect = prospectResponse.body

  // Fresh firm: the only prospect is the one just seeded, so the count is deterministic.
  // Scope to the hero badge (exact) — "N prospects" also appears in the metric hint and funnel copy.
  const prospectBadge = (label) => page.locator('.hero-meta').getByText(label, { exact: true })
  await page.goto('/dashboard')
  await expect(prospectBadge('1 prospects')).toBeVisible()

  await page.goto('/pipeline')
  await expect(page.getByTestId(`pipeline-column-${stage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()

  // Archive from the detail route (the board has no archive affordance).
  await page.goto(`/profiles/${prospect.id}`)
  const archivePanel = page.getByTestId('profile-archive')
  await archivePanel.getByRole('button', { name: 'Archive profile' }).click()
  await archivePanel.getByRole('button', { name: 'Confirm archive' }).click()
  await expect(page.getByText('Profile archived.')).toBeVisible()

  // Gone from the board and the dashboard prospect count drops to zero.
  await page.goto('/pipeline')
  await expect(page.getByTestId(`pipeline-card-${prospect.id}`)).toHaveCount(0)
  await page.goto('/dashboard')
  await expect(prospectBadge('0 prospects')).toBeVisible()

  // Restore returns it to its original stage on the board and to the dashboard count.
  await page.goto(`/profiles/${prospect.id}`)
  await page.getByTestId('profile-restore').click()
  await expect(page.getByText('Profile restored.')).toBeVisible()

  await page.goto('/pipeline')
  await expect(page.getByTestId(`pipeline-column-${stage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  await page.goto('/dashboard')
  await expect(prospectBadge('1 prospects')).toBeVisible()
})
