import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('analytics page renders SVG charts with seeded data and exposes raw JSON', async ({ page, seededRunId }, testInfo) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'charts')
  const auth = { csrfToken, sessionCookie }

  const prospects = []
  for (const label of ['one', 'two', 'three']) {
    const response = await apiFromPage(
      page,
      'POST',
      '/api/profiles',
      {
        kind: 'prospect',
        firstName: 'Chart',
        lastName: `Prospect ${label}`,
        email: deterministicEmail(seededRunId, `charts-prospect-${label}`)
      },
      auth
    )
    expect(response.status).toBe(201)
    prospects.push(response.body)
  }

  // Move two prospects forward so the funnel and stage aging have multiple stages.
  for (const [index, stage] of ['gather_oi', 'analysis'].entries()) {
    const moveResponse = await apiFromPage(
      page,
      'PATCH',
      `/api/profiles/${prospects[index].id}/stage`,
      { stage },
      auth
    )
    expect(moveResponse.ok).toBeTruthy()
  }

  await signInFromUi(page, email, password)
  await page.getByRole('link', { name: 'Analytics', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Analytics', exact: true })).toBeVisible()

  // Funnel chart renders as an SVG with one bar per populated stage.
  const funnelChart = page.getByTestId('funnel-chart')
  await expect(funnelChart.locator('svg')).toBeVisible()
  expect(await funnelChart.locator('[data-chart-bar]').count()).toBeGreaterThanOrEqual(3)
  await expect(funnelChart.locator('svg text', { hasText: 'Discovery' }).first()).toBeVisible()
  await expect(funnelChart.locator('svg text', { hasText: 'Gather OI' }).first()).toBeVisible()

  // Stage aging renders a labeled row per stage (freshly seeded prospects sit
  // at ~0 days, so zero-width bars are legitimately absent).
  const stageAgingChart = page.getByTestId('stage-aging-chart')
  await expect(stageAgingChart.locator('svg')).toBeVisible()
  await expect(stageAgingChart.locator('svg text', { hasText: 'Discovery' }).first()).toBeVisible()
  await expect(stageAgingChart.locator('svg text', { hasText: 'Analysis' }).first()).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('analytics-charts.png'), fullPage: true })

  // Charts keep an accessible table twin.
  await expect(funnelChart.locator('table caption')).toHaveText('Funnel by stage')

  // Raw data stays reachable behind the details toggle.
  const funnelSection = page.locator('section.section-card', {
    has: page.getByRole('heading', { name: 'Funnel', exact: true })
  })
  const rawToggle = funnelSection.getByText('View raw data (funnel)')
  const rawBlock = funnelSection.locator('pre.json-block')
  await expect(rawBlock).toBeHidden()
  await rawToggle.click()
  await expect(rawBlock).toBeVisible()
  await expect(rawBlock).toContainText('"stage": "discovery"')
  await rawToggle.click()
  await expect(rawBlock).toBeHidden()

  // Dashboard reuses the funnel chart for its compact overview.
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  const dashboardFunnel = page.getByTestId('dashboard-funnel-chart')
  await expect(dashboardFunnel.locator('svg')).toBeVisible()
  expect(await dashboardFunnel.locator('[data-chart-bar]').count()).toBeGreaterThanOrEqual(3)
})
