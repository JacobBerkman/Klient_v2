import { PDFDocument } from 'pdf-lib'
import { apiFromPage, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

// Not @release-blocking: covers the intake-form prefill loop — the client's form
// opens populated from firm records (profile / spouse / household), they correct
// what is stale, and their answer is what the exported PDF reads.
async function buildIntakePdfBase64() {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const form = pdf.getForm()
  form.createTextField('client_first_name').addToPage(page, { x: 72, y: 700, width: 240, height: 24 })
  form.createTextField('client_email').addToPage(page, { x: 72, y: 660, width: 240, height: 24 })
  form.createTextField('spouse_first_name').addToPage(page, { x: 72, y: 620, width: 240, height: 24 })
  return Buffer.from(await pdf.save()).toString('base64')
}

test('the portal intake form opens pre-filled from firm records and the client can correct it', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'portal-prefill')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  // Auto-build the document template; it generates the linked intake form and
  // the record fallbacks that prefill reads.
  const templateResponse = await apiFromPage(
    page,
    'POST',
    '/api/templates/auto-build',
    {
      name: `Prefill Intake ${seededRunId}`,
      fileName: 'prefill-intake.pdf',
      fileBytesBase64: await buildIntakePdfBase64()
    },
    auth
  )
  expect(templateResponse.status, JSON.stringify(templateResponse.body)).toBe(201)
  const documentTemplate = templateResponse.body
  expect(documentTemplate.linkedFormTemplateId).toBeTruthy()

  const primaryResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    { kind: 'client', firstName: 'Harper', lastName: 'Hartley', email: 'harper.stale@hartley.example' },
    auth
  )
  expect(primaryResponse.status).toBe(201)
  const primary = primaryResponse.body

  // Creating the spouse also auto-creates the household, which is where the
  // household_name prefill comes from.
  const spouseResponse = await apiFromPage(
    page,
    'POST',
    '/api/households/create-spouse',
    {
      primaryClientId: primary.id,
      spouse: { firstName: 'Sydney', lastName: 'Hartley', email: 'sydney@hartley.example' }
    },
    auth
  )
  expect(spouseResponse.status, JSON.stringify(spouseResponse.body)).toBe(201)

  const portalLinkResponse = await apiFromPage(
    page,
    'POST',
    '/api/portal-links',
    {
      profileId: primary.id,
      templateIds: [documentTemplate.linkedFormTemplateId],
      expiresInHours: 2,
      maxUses: 3
    },
    auth
  )
  expect(portalLinkResponse.status).toBe(201)

  await page.goto(`/portal?token=${portalLinkResponse.body.token}`)
  await expect(page.getByRole('heading', { name: 'Complete a form' })).toBeVisible()

  // The client's known details are already in the form — pulled from their
  // profile, their spouse's profile, and the household record.
  await expect(page.getByLabel('Client First Name')).toHaveValue('Harper')
  await expect(page.getByLabel('Spouse First Name')).toHaveValue('Sydney')
  const emailField = page.getByLabel('Client Email')
  await expect(emailField).toHaveValue('harper.stale@hartley.example')

  // They correct the stale email and submit; the answer is theirs, not the record's.
  await emailField.fill('harper.new@hartley.example')
  await page.getByRole('button', { name: 'Submit form' }).click()
  await expect(page.getByText('Form submitted.')).toBeVisible()

  const submissions = await apiFromPage(page, 'GET', '/api/forms/submissions', undefined, auth)
  const submitted = submissions.body.find((entry) => entry.clientId === primary.id && entry.status === 'submitted')
  expect(submitted, 'the portal submission is recorded').toBeTruthy()
  expect(submitted.data.client_email).toBe('harper.new@hartley.example')
  expect(submitted.data.client_first_name).toBe('Harper')
  expect(submitted.data.spouse_first_name).toBe('Sydney')
})
