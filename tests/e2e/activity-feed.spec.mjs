import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('activity feed shows audited actions with actor and summary and filters by category', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'activity')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  // Audited action 1: create a prospect (profile.created -> Profiles category).
  const boardResponse = await apiFromPage(page, 'GET', '/api/board', undefined, auth)
  expect(boardResponse.ok, JSON.stringify(boardResponse.body)).toBeTruthy()
  const activeStages = boardResponse.body.stages.filter((stage) => stage.active)
  const firstStage = activeStages[0].id
  const targetStage = activeStages[1].id

  const prospectResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'prospect',
      stage: firstStage,
      firstName: 'Activity',
      lastName: 'Subject',
      email: deterministicEmail(seededRunId, 'activity-prospect')
    },
    auth
  )
  expect(prospectResponse.status).toBe(201)
  const prospect = prospectResponse.body

  // Audited action 2: move the prospect to a new stage (pipeline.stage_changed -> Pipeline category).
  const moveResponse = await apiFromPage(
    page,
    'PATCH',
    '/api/pipeline/reorder',
    { profileId: prospect.id, toStage: targetStage },
    auth
  )
  expect(moveResponse.status, JSON.stringify(moveResponse.body)).toBe(200)

  await page.goto('/activity')
  await expect(page.getByRole('heading', { name: 'Everything happening across the firm' })).toBeVisible()

  const createdSummary = page.getByText('Created a prospect', { exact: true })
  const movedSummary = page.getByText(`Moved a profile to ${targetStage}`, { exact: true })
  await expect(createdSummary).toBeVisible()
  await expect(movedSummary).toBeVisible()
  // Actor attribution: the seeded admin registered as "E2E Admin".
  await expect(page.locator('.activity-actor', { hasText: 'E2E Admin' }).first()).toBeVisible()

  // Narrowing to the Pipeline category keeps the stage move and drops the profile-create event.
  await page.getByLabel('Category').selectOption({ label: 'Pipeline' })
  await expect(movedSummary).toBeVisible()
  await expect(page.getByText('Created a prospect', { exact: true })).toHaveCount(0)

  // A fresh firm has only a handful of events (single page), so there is no Load more control.
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
})
