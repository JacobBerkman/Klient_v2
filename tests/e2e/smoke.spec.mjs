import { test, expect, waitForAppReady } from './bootstrap.mjs'

test('@release-blocking admin can sign in and land on dashboard', async ({ page }) => {
  await waitForAppReady(page)

  await page.getByRole('textbox', { name: 'Email' }).fill('admin@demo.test')
  await page.getByRole('textbox', { name: 'Password' }).fill('ChangeMe123!')
  await page.getByTestId('login-submit').click()

  await expect(page.getByTestId('auth-status')).toContainText('Signed in successfully.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})
