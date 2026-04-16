import { deterministicEmail, signInFromUi, test, expect } from './bootstrap.mjs'

test('legacy advisor shell is reachable only through explicit /legacy route', async ({ page, seededRunId }) => {
  const email = deterministicEmail(seededRunId, 'legacy-admin')
  const password = 'StrongPass123!'

  await page.goto('/legacy')
  await expect(page.locator('#register-form')).toBeVisible()
  await expect(page.locator('#login-form')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).not.toBeVisible()

  await page.locator('#register-form input[name="firmName"]').fill(`Legacy Firm ${seededRunId}`)
  await page.locator('#register-form input[name="firstName"]').fill('Legacy')
  await page.locator('#register-form input[name="lastName"]').fill('Admin')
  await page.locator('#register-form input[name="email"]').fill(email)
  await page.locator('#register-form input[name="password"]').fill(password)
  await page.locator('#register-form button[type="submit"]').click()

  await expect(page.getByTestId('auth-status')).toContainText('Firm admin account created.')
  await page.request.post('/api/logout')
  await signInFromUi(page, email, password, '/legacy')
})

test('legacy portal shell is reachable only through explicit /legacy/portal route', async ({ page }) => {
  await page.goto('/legacy/portal')
  await expect(page.locator('#portal-upload-form')).toBeVisible()
  await expect(page.locator('#portal-form')).toBeVisible()

  await page.goto('/portal')
  await expect(page.locator('#portal-upload-form')).toHaveCount(0)
  await expect(page.locator('#root')).toHaveCount(1)
})
