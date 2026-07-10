import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('stage management UI creates, reorders, renames, and deactivates pipeline stages', async ({
  page,
  seededRunId
}) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'stage-admin')
  await signInFromUi(page, email, password)

  await page.getByRole('link', { name: 'Stages' }).click()
  await expect(page.getByRole('heading', { name: 'Stages', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Stage order' })).toBeVisible()

  // The first list call seeds the firm's default stage records.
  await expect(page.getByTestId('stage-row-discovery')).toBeVisible()

  // Create a stage; it lands at the end of the board order.
  await page.getByLabel('Stage key').fill('e2e_priority_review')
  await page.getByLabel('Stage label').fill('Priority Review')
  await page.getByRole('button', { name: 'Create stage' }).click()
  await expect(page.getByText('Stage created.')).toBeVisible()
  const createdRow = page.getByTestId('stage-row-e2e_priority_review')
  await expect(createdRow).toContainText('Priority Review')
  await expect(page.getByTestId('stage-order-e2e_priority_review')).toHaveText('11')

  // Reorder with the keyboard-accessible Up button and confirm persistence.
  await page.getByRole('button', { name: 'Move Priority Review up' }).click()
  await expect(page.getByText('Stage order updated.')).toBeVisible()
  await expect(page.getByTestId('stage-order-e2e_priority_review')).toHaveText('10')

  // Rename through the inline metadata editor.
  await page.getByRole('button', { name: 'Rename Priority Review' }).click()
  await page.getByLabel('New label for Priority Review').fill('Priority Review Plus')
  await page.getByRole('button', { name: 'Save Priority Review' }).click()
  await expect(page.getByText('Stage updated.')).toBeVisible()
  await expect(createdRow).toContainText('Priority Review Plus')

  // Deactivate requires an explicit confirmation that explains the behavior.
  await page.getByRole('button', { name: 'Deactivate Discovery' }).click()
  await expect(page.getByText(/Prospects already in this stage keep it/)).toBeVisible()
  await page.getByRole('button', { name: 'Confirm deactivate Discovery' }).click()
  await expect(page.getByText('Stage "Discovery" deactivated.')).toBeVisible()
  await expect(page.getByTestId('stage-row-discovery').getByText('Inactive')).toBeVisible()

  // The board reflects the new configuration: created column present, deactivated
  // column still rendered but marked inactive.
  await page.getByRole('link', { name: 'Pipeline', exact: true }).click()
  await expect(page.getByTestId('pipeline-column-e2e_priority_review')).toBeVisible()
  await expect(page.getByTestId('pipeline-column-e2e_priority_review')).toContainText('Priority Review Plus')
  await expect(page.getByTestId('pipeline-column-discovery').getByText('Inactive')).toBeVisible()
})

test('kanban stage moves render optimistically and roll back on pipeline order conflicts', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'optimistic')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const stages = boardResponse.body.stages.filter((stage) => stage.active)
  const firstStage = stages[0].id
  const targetStage = stages[1].id
  const thirdStage = stages[2].id

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage: firstStage,
      firstName: 'Optimistic',
      lastName: 'Prospect',
      email: deterministicEmail(seededRunId, 'optimistic-prospect')
    },
    auth
  )
  expect(prospectResponse.status).toBe(201)
  const prospect = prospectResponse.body

  await page.goto('/pipeline')
  const card = page.getByTestId(`pipeline-card-${prospect.id}`)
  await expect(page.getByTestId(`pipeline-column-${firstStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()

  // Hold the PATCH response until the optimistic render is asserted, proving the
  // card moves before the network settles rather than after a refetch.
  let releaseMove
  const moveBlocked = new Promise((resolve) => {
    releaseMove = resolve
  })
  await page.route('**/api/pipeline/reorder', async (route) => {
    await moveBlocked
    await route.fallback()
  })

  await card.getByRole('combobox').selectOption(targetStage)
  await expect(page.getByTestId(`pipeline-column-${targetStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  await expect(page.getByText('Moving stage...')).toBeVisible()

  releaseMove()
  await expect(page.getByText(`Moved to ${targetStage}.`)).toBeVisible()
  await expect(page.getByTestId(`pipeline-column-${targetStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  await page.unroute('**/api/pipeline/reorder')

  // A PIPELINE_ORDER_CONFLICT rolls the optimistic move back and refetches the
  // server board so the user sees the true state.
  await page.route('**/api/pipeline/reorder', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'Board version mismatch.',
        error: { code: 'PIPELINE_ORDER_CONFLICT', message: 'Board version mismatch.', details: {} }
      })
    })
  )

  await card.getByRole('combobox').selectOption(thirdStage)
  await expect(page.getByText('Board changed in another session. Reloaded the latest board.')).toBeVisible()
  await page.unroute('**/api/pipeline/reorder')

  await expect(page.getByTestId(`pipeline-column-${targetStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toBeVisible()
  await expect(page.getByTestId(`pipeline-column-${thirdStage}`).getByTestId(`pipeline-card-${prospect.id}`)).toHaveCount(0)
})
