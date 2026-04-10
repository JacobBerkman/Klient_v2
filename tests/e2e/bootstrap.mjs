import { expect, test as base } from '@playwright/test'

function sanitizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const test = base.extend({
  seededRunId: async ({}, use, testInfo) => {
    const seed = sanitizeToken(process.env.TEST_SEED || 'klient-seed')
    const title = sanitizeToken(testInfo.title)
    await use(`${seed}-${testInfo.parallelIndex}-${title}`)
  }
})

export { expect }

export async function waitForAppReady(page) {
  await expect.poll(async () => {
    const response = await page.request.get('/ready')
    return response.status()
  }).toBe(200)

  await page.goto('/')
  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('register-form')).toBeVisible()
}

export async function registerAdminViaApi(page, seededRunId, label = 'admin') {
  const email = `${seededRunId}-${sanitizeToken(label)}@e2e.test`
  const password = 'StrongPass123!'
  const response = await page.request.post('/api/register', {
    data: {
      firmName: `E2E Firm ${seededRunId}-${label}`,
      firstName: 'E2E',
      lastName: 'Admin',
      email,
      password
    }
  })
  expect(response.ok()).toBeTruthy()
  return { email, password }
}

export async function signInFromUi(page, email, password) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('auth-status')).toContainText('Signed in successfully.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test.afterEach(async ({ page }) => {
  await page.request.post('/api/logout').catch(() => {})
  await page.context().clearCookies()
})
