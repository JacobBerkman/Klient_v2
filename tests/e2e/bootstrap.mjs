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
  secureCookieHeaderRouting: [
    async ({ page }, use) => {
      await page.route('**/api/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const headers = {
          ...request.headers(),
          'x-forwarded-proto': 'https'
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method().toUpperCase())) {
          headers.origin = `https://${url.host}`
          headers.referer = `https://${url.host}/`
        }
        await route.continue({ headers })
      })
      await use()
    },
    { auto: true }
  ],
  seededRunId: async ({}, use, testInfo) => {
    const seed = sanitizeToken(process.env.TEST_SEED || 'klient-seed')
    const title = sanitizeToken(testInfo.title)
    await use(`${seed}-p${testInfo.parallelIndex}-r${testInfo.retry}-${title}`)
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

export async function waitForAppReady(page, path = '/') {
  await expect
    .poll(async () => {
      const response = await page.request.get('/ready')
      return response.status()
    })
    .toBe(200)

  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
  if (path === '/') {
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByTestId('login-form')).toBeVisible()
    return
  }

  if (path === '/legacy' || path.startsWith('/legacy/')) {
    await expect(page.locator('#login-form')).toBeVisible()
    await expect(page.locator('#register-form')).toBeVisible()
    return
  }

  await expect(page.locator('#root')).toHaveCount(1)
  await expect(page.locator('#login-form')).toHaveCount(0)
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
  const body = await response.json()
  const setCookie = response.headers()['set-cookie'] || ''
  const sessionMatch = setCookie.match(/__Host-klient-session=([^;,\s]+)/)
  const csrfCookieMatch = setCookie.match(/__Host-klient-csrf=([^;,\s]+)/)
  const sessionCookie = [
    sessionMatch ? `__Host-klient-session=${sessionMatch[1]}` : '',
    csrfCookieMatch ? `__Host-klient-csrf=${csrfCookieMatch[1]}` : ''
  ]
    .filter(Boolean)
    .join('; ')
  return { email, password, adminId, csrfToken: body.csrfToken || '', sessionCookie }
}

export function deterministicEmail(seededRunId, label) {
  return `${createDeterministicId(seededRunId, label)}@e2e.test`
}

export function csrfHeaders(csrfToken, sessionCookie = '') {
  const baseUrl =
    process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`
  const originUrl = new URL(baseUrl)

  return {
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    origin: originUrl.origin,
    referer: `${originUrl.origin}/`
  }
}

function upsertCookie(cookieHeader, name, value) {
  const nextCookies = String(cookieHeader || '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .filter((cookie) => !cookie.startsWith(`${name}=`))
  if (value) {
    nextCookies.push(`${name}=${value}`)
  }
  return nextCookies.join('; ')
}

function applyAuthCookies(auth, setCookieHeader) {
  if (!auth || !setCookieHeader) return
  for (const name of ['__Host-klient-session', '__Host-klient-csrf']) {
    const match = setCookieHeader.match(new RegExp(`${name}=([^;,\\s]+)`))
    if (match) {
      auth.sessionCookie = upsertCookie(auth.sessionCookie, name, match[1])
    }
  }
}

export async function apiFromPage(page, method, path, data = undefined, auth = {}) {
  const response = await page.request.fetch(path, {
    method,
    headers: csrfHeaders(auth.csrfToken, auth.sessionCookie),
    ...(data !== undefined ? { data } : {})
  })
  applyAuthCookies(auth, response.headers()['set-cookie'] || '')
  auth.csrfToken = response.headers()['x-csrf-token'] || auth.csrfToken || ''
  const contentType = response.headers()['content-type'] || ''
  const body = contentType.includes('application/json') ? await response.json() : await response.text()
  return { ok: response.ok(), status: response.status(), body }
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

export async function signInFromUi(page, email, password, path = '/') {
  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
  if (path === '/legacy') {
    await page.locator('#login-form input[name="email"]').fill(email)
    await page.locator('#login-form input[name="password"]').fill(password)
    await page.locator('#login-form button[type="submit"]').click()
    await expect(page.locator('#auth-status')).toContainText('Signed in successfully.')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    return
  }

  const dashboardHeading = page.getByRole('heading', { name: 'Dashboard', exact: true })
  const loginEmail = page.getByRole('textbox', { name: 'Email' })
  await expect
    .poll(async () => {
      if (await dashboardHeading.isVisible().catch(() => false)) return 'dashboard'
      if (await loginEmail.isVisible().catch(() => false)) return 'login'
      return 'pending'
    })
    .not.toBe('pending')

  if (await dashboardHeading.isVisible().catch(() => false)) {
    return
  }

  await loginEmail.fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
}

test.afterEach(async ({ page }) => {
  await page.request.post('/api/logout').catch(() => {})
  await page.context().clearCookies()
})
