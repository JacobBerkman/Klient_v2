import { registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('theme control sets a resolved data-theme, persists across reload, and system mode follows the OS scheme', async ({
  page,
  seededRunId
}) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'theme-admin')
  // Pin the emulated OS scheme so the default 'system' preference is deterministic.
  await page.emulateMedia({ colorScheme: 'light' })
  await signInFromUi(page, email, password)

  const html = page.locator('html')
  const themeControl = page.getByRole('group', { name: 'Theme' })
  await expect(html).toHaveAttribute('data-theme', 'light')

  // Explicit dark preference resolves immediately and survives a reload via
  // localStorage plus the pre-paint script in index.html.
  await themeControl.getByRole('button', { name: 'Dark' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')

  // System mode resolves against the emulated prefers-color-scheme and keeps
  // following live scheme changes through the matchMedia listener.
  await themeControl.getByRole('button', { name: 'System' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveAttribute('data-theme', 'dark')

  // Explicit light preference wins over a dark OS scheme.
  await themeControl.getByRole('button', { name: 'Light' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
})

test('mutations surface toast feedback in the notifications region', async ({ page, seededRunId }) => {
  const { email, password } = await registerAdminViaApi(page, seededRunId, 'toast-admin')
  await signInFromUi(page, email, password)

  await page.goto('/profiles')
  await page.getByLabel('First name').fill('Toast')
  await page.getByLabel('Last name').fill('Feedback')
  await page.getByRole('button', { name: 'Create profile' }).click()

  // Success feedback lands in the named live region as a polite status toast
  // and can be dismissed manually.
  const notifications = page.getByRole('region', { name: 'Notifications' })
  const toast = notifications.getByRole('status').filter({ hasText: 'Profile created.' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(toast).toHaveCount(0)
})
