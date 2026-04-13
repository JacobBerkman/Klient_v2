import { expect, test as base } from '@playwright/test'

function sanitizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function createDeterministicId(seededRunId, label) {
  return `${seededRunId}-${sanitizeToken(label)}`
}

export const test = base.extend({
  seededRunId: async ({}, use, testInfo) => {
    const seed = sanitizeToken(process.env.TEST_SEED || 'klient-seed')
    const title = sanitizeToken(testInfo.title)
    await use(`${seed}-${testInfo.parallelIndex}-${title}`)
  },
  cleanupActions: async ({}, use) => {
    const actions = []
    await use(actions)
    while (actions.length > 0) {
      const action = actions.pop()
      await action()
    }
  }
})

export { expect }

export async function waitForAppReady(page) {
  await expect.poll(async () => {
    const response = await page.request.get('/ready')
    return response.status()
  }).toBe(200)

  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('login-form')).toBeVisible()
  await expect(page.getByTestId('register-form')).toBeVisible()
}

export async function registerAdminViaApi(page, seededRunId, label = 'admin') {
  const adminId = createDeterministicId(seededRunId, label)
  const email = `${adminId}@e2e.test`
  const password = 'StrongPass123!'
  const response = await page.request.post('/api/register', {
    data: {
      firmName: `E2E Firm ${adminId}`,
      firstName: 'E2E',
      lastName: 'Admin',
      email,
      password
    }
  })
  expect(response.ok()).toBeTruthy()
  return { email, password, adminId }
}

export function deterministicEmail(seededRunId, label) {
  return `${createDeterministicId(seededRunId, label)}@e2e.test`
}

export async function inviteAndAcceptAdvisor(page, seededRunId, label = 'advisor') {
  const advisorId = createDeterministicId(seededRunId, label)
  const email = `${advisorId}@e2e.test`
  const password = 'StrongPass123!'

  const inviteResponse = await page.request.post('/api/invites', {
    data: { email, role: 'advisor' }
  })
  expect(inviteResponse.status()).toBe(201)
  const invite = await inviteResponse.json()

  const acceptResponse = await page.request.post('/api/invites/accept', {
    data: {
      token: invite.token,
      firstName: 'Ops',
      lastName: 'Advisor',
      password
    }
  })
  expect(acceptResponse.ok()).toBeTruthy()

  return { email, password, advisorId }
}

export async function signInFromUi(page, email, password) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
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
