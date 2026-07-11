import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('rapid successive kanban moves both land without a spurious board conflict', async ({ page, seededRunId }) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'rapid-mover')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const stages = boardResponse.body.stages.filter((stage) => stage.active)
  const firstStage = stages[0].id
  const secondStage = stages[1].id
  const thirdStage = stages[2].id

  const prospects = []
  for (const label of ['rapid-one', 'rapid-two', 'rapid-three']) {
    const response = await apiFromPage(
      page,
      'POST',
      '/api/profiles',
      {
        kind: 'prospect',
        stage: firstStage,
        firstName: 'Rapid',
        lastName: label,
        email: deterministicEmail(seededRunId, label)
      },
      auth
    )
    expect(response.status).toBe(201)
    prospects.push(response.body)
  }
  const [cardOne, cardTwo] = prospects

  await page.goto('/pipeline')
  const firstColumn = page.getByTestId(`pipeline-column-${firstStage}`)
  await expect(firstColumn.getByTestId(`pipeline-card-${cardOne.id}`)).toBeVisible()
  await expect(firstColumn.getByTestId(`pipeline-card-${cardTwo.id}`)).toBeVisible()

  // Hold the first reorder PATCH until the second move has been fired so the
  // two moves are deterministically in flight together. The regression this
  // guards: the second move used to carry the stale pre-move boardVersion and
  // was guaranteed a PIPELINE_ORDER_CONFLICT plus a bogus rollback.
  let reorderRequests = 0
  let releaseFirstMove
  const firstMoveBlocked = new Promise((resolve) => {
    releaseFirstMove = resolve
  })
  await page.route('**/api/pipeline/reorder', async (route) => {
    reorderRequests += 1
    if (reorderRequests === 1) await firstMoveBlocked
    await route.fallback()
  })

  await page
    .getByTestId(`pipeline-card-${cardOne.id}`)
    .getByRole('combobox')
    .selectOption(secondStage)
  await page
    .getByTestId(`pipeline-card-${cardTwo.id}`)
    .getByRole('combobox')
    .selectOption(thirdStage)

  // Both moves render optimistically while the first request is still pending.
  await expect(page.getByTestId(`pipeline-column-${secondStage}`).getByTestId(`pipeline-card-${cardOne.id}`)).toBeVisible()
  await expect(page.getByTestId(`pipeline-column-${thirdStage}`).getByTestId(`pipeline-card-${cardTwo.id}`)).toBeVisible()
  await expect(page.getByText('Moving stage...')).toBeVisible()

  releaseFirstMove()
  await expect(page.getByText(`Moved to ${thirdStage}.`)).toBeVisible()
  await page.unroute('**/api/pipeline/reorder')
  expect(reorderRequests).toBe(2)

  // Neither move conflicted or rolled back: both cards stay in their targets
  // and no error message appeared.
  await expect(page.getByText('Board changed in another session. Reloaded the latest board.')).toHaveCount(0)
  await expect(page.getByTestId(`pipeline-column-${secondStage}`).getByTestId(`pipeline-card-${cardOne.id}`)).toBeVisible()
  await expect(page.getByTestId(`pipeline-column-${thirdStage}`).getByTestId(`pipeline-card-${cardTwo.id}`)).toBeVisible()
  await expect(firstColumn.getByTestId(`pipeline-card-${cardOne.id}`)).toHaveCount(0)
  await expect(firstColumn.getByTestId(`pipeline-card-${cardTwo.id}`)).toHaveCount(0)

  // The server agrees after the network settles.
  const settledBoard = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(settledBoard.ok, JSON.stringify(settledBoard.body)).toBeTruthy()
  const stageOf = (profileId) =>
    settledBoard.body.columns.find((column) => column.cards.some((card) => card.id === profileId))?.stage
  expect(stageOf(cardOne.id)).toBe(secondStage)
  expect(stageOf(cardTwo.id)).toBe(thirdStage)
})
