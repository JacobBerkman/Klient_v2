import {
  apiFromPage,
  csrfHeaders,
  deterministicEmail,
  registerAdminViaApi,
  signInFromUi,
  test,
  expect
} from './bootstrap.mjs'

test('advisor uploads, downloads, and archives a profile attachment', async ({ page, seededRunId }) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'attachments')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const clientResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Attachment',
      lastName: 'Owner',
      email: deterministicEmail(seededRunId, 'attachment-owner')
    },
    auth
  )
  expect(clientResponse.status, JSON.stringify(clientResponse.body)).toBe(201)
  const client = clientResponse.body

  await page.goto(`/profiles/${client.id}`)
  await expect(page.getByText('No attachments yet.')).toBeVisible()

  // Upload a small text file via the raw presign -> PUT -> complete handshake the page drives.
  const fileName = `advisor-note-${seededRunId}.txt`
  const contents = 'hello advisor attachment' // 24 bytes -> formatBytes renders "24 B"
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from(contents)
  })
  await expect(page.getByTestId('attachment-status')).toContainText(`Uploaded "${fileName}".`)

  const row = page.getByTestId('attachment-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(fileName)
  await expect(row).toContainText('24 B')

  // The download link href must serve the file. page.request bypasses the https
  // cookie-rewrite fixture, so authenticate explicitly with the seeded session.
  const downloadHref = await row.getByRole('link', { name: 'Download' }).getAttribute('href')
  expect(downloadHref).toBeTruthy()
  const downloadResponse = await page.request.get(downloadHref, {
    headers: csrfHeaders(auth.csrfToken, auth.sessionCookie)
  })
  expect(downloadResponse.status()).toBe(200)

  // Two-step archive removes it from the default (non-archived) attachments list.
  await row.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm archive' }).click()
  await expect(page.getByTestId('attachment-status')).toContainText('Attachment archived.')
  await expect(page.getByTestId('attachment-row')).toHaveCount(0)
  await expect(page.getByText('No attachments yet.')).toBeVisible()
})
