import { test, expect } from '@playwright/test'

test('admin can sign in and land on dashboard', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('textbox', { name: 'Email' }).fill('admin@demo.test')
  await page.getByRole('textbox', { name: 'Password' }).fill('ChangeMe123!')
  await page.getByRole('button', { name: 'Sign In' }).click()

  await expect(page.locator('#auth-status')).toContainText('Signed in successfully.')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})
