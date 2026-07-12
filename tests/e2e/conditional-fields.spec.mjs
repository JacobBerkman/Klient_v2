import { apiFromPage, deterministicEmail, registerAdminViaApi, signInFromUi, test, expect } from './bootstrap.mjs'

test('@release-blocking a visibleIf field stays hidden until its trigger value and then submits', async ({
  page,
  seededRunId
}) => {
  const { email, password, csrfToken, sessionCookie } = await registerAdminViaApi(page, seededRunId, 'conditional')
  const auth = { csrfToken, sessionCookie }
  await signInFromUi(page, email, password)

  const profileResponse = await apiFromPage(
    page,
    'POST',
    '/api/profiles',
    {
      kind: 'client',
      firstName: 'Conditional',
      lastName: 'Client',
      email: deterministicEmail(seededRunId, 'conditional-client')
    },
    auth
  )
  expect(profileResponse.status, JSON.stringify(profileResponse.body)).toBe(201)
  const profile = profileResponse.body

  // A single section with a select controller and a conditional field that only
  // shows when the controller equals "yes".
  const templateResponse = await apiFromPage(
    page,
    'POST',
    '/api/forms/templates',
    {
      name: `Conditional Intake ${seededRunId}`,
      sections: [
        {
          key: 'dependents',
          title: 'Dependents',
          fields: [
            { key: 'has_dependents', label: 'Do you have dependents?', type: 'select', options: ['yes', 'no'] },
            {
              key: 'dependent_count',
              label: 'Number of dependents',
              type: 'text',
              visibleIf: { field: 'has_dependents', op: 'equals', value: 'yes' }
            }
          ]
        }
      ]
    },
    auth
  )
  expect(templateResponse.status, JSON.stringify(templateResponse.body)).toBe(201)
  const template = templateResponse.body

  const portalLinkResponse = await apiFromPage(
    page,
    'POST',
    '/api/portal-links',
    { profileId: profile.id, templateIds: [template.id], expiresInHours: 2, maxUses: 3 },
    auth
  )
  expect(portalLinkResponse.status).toBe(201)
  const portalLink = portalLinkResponse.body

  await page.goto(`/portal?token=${portalLink.token}`)
  await expect(page.getByRole('heading', { name: 'Complete a form' })).toBeVisible()

  // The controller is visible; the conditional field is not rendered yet.
  const controller = page.getByLabel('Do you have dependents?')
  await expect(controller).toBeVisible()
  await expect(page.getByLabel('Number of dependents')).toHaveCount(0)

  // Selecting the trigger value reveals the conditional field.
  await controller.selectOption('yes')
  const conditional = page.getByLabel('Number of dependents')
  await expect(conditional).toBeVisible()
  await conditional.fill('2')

  await page.getByRole('button', { name: 'Submit form' }).click()
  await expect(page.getByText('Form submitted.')).toBeVisible()
})
