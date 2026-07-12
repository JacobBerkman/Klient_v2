import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('@release-blocking prospect converts to client from the detail route with pipeline fields cleared', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'convert-detail')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage: 'discovery',
      firstName: 'Detail',
      lastName: 'Convert',
      email: deterministicEmail(seededRunId, 'convert-detail-prospect')
    },
    auth
  )
  expect(prospectResponse.status, JSON.stringify(prospectResponse.body)).toBe(201)
  const prospect = prospectResponse.body

  await page.goto(`/profiles/${prospect.id}`)
  const meta = page.locator('.hero-meta')
  await expect(meta.getByText('prospect', { exact: true })).toBeVisible()

  // Two-step confirm: reveal the confirmation copy, then commit the conversion.
  const convertPanel = page.getByTestId('profile-convert')
  await convertPanel.getByRole('button', { name: 'Convert to client' }).click()
  await expect(convertPanel.getByText(/Converting promotes this prospect/)).toBeVisible()
  await convertPanel.getByRole('button', { name: 'Confirm convert to client' }).click()

  await expect(page.getByText('Prospect converted to client.')).toBeVisible()
  // The kind badge flips and the stage clears (pipeline fields removed on convert).
  await expect(meta.getByText('client', { exact: true })).toBeVisible()
  await expect(meta.getByText('No stage')).toBeVisible()
  // The convert affordance only exists for prospects, so it is gone once converted.
  await expect(page.getByTestId('profile-convert')).toHaveCount(0)
})

test('@release-blocking prospect converts from a terminal kanban column and leaves the board', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'convert-kanban')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const activeStages = boardResponse.body.stages.filter((stage) => stage.active)
  const firstStage = activeStages[0].id
  const terminalStage = (boardResponse.body.stageMetadata || []).find((stage) => stage.isTerminal)?.id
  expect(terminalStage, 'a terminal stage should exist on the seeded board').toBeTruthy()
  expect(terminalStage).not.toBe(firstStage)

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage: firstStage,
      firstName: 'Kanban',
      lastName: 'Convert',
      email: deterministicEmail(seededRunId, 'convert-kanban-prospect')
    },
    auth
  )
  expect(prospectResponse.status).toBe(201)
  const prospect = prospectResponse.body

  await page.goto('/pipeline')
  const card = page.getByTestId(`pipeline-card-${prospect.id}`)
  await expect(page.getByTestId(`pipeline-column-${firstStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()

  // Move the card into the terminal column; only there does the convert action appear.
  await card.getByRole('combobox').selectOption(terminalStage)
  await expect(page.getByText(`Moved to ${terminalStage}.`)).toBeVisible()
  await expect(
    page.getByTestId(`pipeline-column-${terminalStage}`).getByTestId(`pipeline-card-${prospect.id}`)
  ).toBeVisible()

  const convertAction = page.getByTestId(`pipeline-card-convert-${prospect.id}`)
  await convertAction.getByRole('button', { name: 'Convert to client' }).click()
  await convertAction.getByRole('button', { name: 'Confirm convert' }).click()

  await expect(page.getByText('Kanban Convert converted to client.')).toBeVisible()
  // The converted client is no longer a prospect card anywhere on the board.
  await expect(page.getByTestId(`pipeline-card-${prospect.id}`)).toHaveCount(0)
})
