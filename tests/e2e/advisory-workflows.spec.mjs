import { expect, test } from '@playwright/test';

async function loginWithDemo(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use Demo Login' }).click();
  await expect(page.locator('#auth-status')).toContainText('admin@demo.test');
}

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

async function authHeaders(page) {
  const token = await page.evaluate(() => localStorage.getItem('klient-token'));
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

test('login and dashboard render with real runtime', async ({ page }) => {
  await loginWithDemo(page);

  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('#view h2')).toHaveText('Dashboard');
  await expect(page.locator('#view')).toContainText('Recent Profiles');
});

test('profile create/list/detail plus household management and forms draft/submit visibility', async ({ page, request }) => {
  await loginWithDemo(page);

  const primaryFirst = id('Client');
  const spouseFirst = id('Spouse');
  const householdName = id('Household');
  const templateName = id('Intake');

  await page.locator('#profile-form select[name="kind"]').selectOption('client');
  await page.locator('#profile-form input[name="firstName"]').fill(primaryFirst);
  await page.locator('#profile-form input[name="lastName"]').fill('Owner');
  await page.locator('#profile-form input[name="email"]').fill(`${primaryFirst}@example.test`);
  await page.locator('#profile-form button[type="submit"]').click();

  await page.locator('#profile-form select[name="kind"]').selectOption('client');
  await page.locator('#profile-form input[name="firstName"]').fill(spouseFirst);
  await page.locator('#profile-form input[name="lastName"]').fill('Owner');
  await page.locator('#profile-form input[name="email"]').fill(`${spouseFirst}@example.test`);
  await page.locator('#profile-form button[type="submit"]').click();

  await page.getByRole('button', { name: 'Clients' }).click();
  await expect(page.locator('#view')).toContainText(primaryFirst);

  await page.locator('#view .item', { hasText: primaryFirst }).getByRole('button', { name: 'Open Profile' }).click();
  await expect(page.locator('#view h2')).toContainText(primaryFirst);
  await expect(page.locator('#view')).toContainText('Profile Summary');

  await page.locator('button#back-to-dashboard').click();

  await page.locator('#household-form input[name="name"]').fill(householdName);
  const primaryOption = await page.locator('#household-form select[name="primaryClientId"] option').filter({ hasText: `${primaryFirst} Owner` }).first().getAttribute('value');
  await page.locator('#household-form select[name="primaryClientId"]').selectOption(primaryOption);
  await page.locator('#household-form button[type="submit"]').click();

  const headers = await authHeaders(page);
  const profilesResponse = await request.get('/api/profiles?kind=client', { headers });
  const profiles = await profilesResponse.json();
  const primaryClient = profiles.find((profile) => profile.firstName === primaryFirst);
  const spouseClient = profiles.find((profile) => profile.firstName === spouseFirst);

  const householdsResponse = await request.get('/api/households', { headers: { Authorization: headers.Authorization } });
  const households = await householdsResponse.json();
  const household = households.find((entry) => entry.name === householdName);

  await request.post(`/api/households/${household.id}/members`, {
    headers,
    data: { clientId: spouseClient.id, role: 'spouse' }
  });

  await page.getByRole('button', { name: 'Households' }).click();
  await expect(page.locator('#view')).toContainText(householdName);
  await expect(page.locator('#view')).toContainText(`Members: 2`);

  await page.locator('#form-template-form input[name="name"]').fill(templateName);
  await page.locator('#form-template-form input[name="description"]').fill('E2E intake form');
  await page.locator('#form-template-form button[type="submit"]').click();

  const templatesResponse = await request.get('/api/forms/templates', { headers: { Authorization: headers.Authorization } });
  const templates = await templatesResponse.json();
  const template = templates.find((entry) => entry.name === templateName);

  const draftResponse = await request.post('/api/forms/submissions', {
    headers,
    data: {
      templateId: template.id,
      clientId: primaryClient.id,
      status: 'draft',
      data: { riskTolerance: 'moderate' }
    }
  });
  const draft = await draftResponse.json();

  await request.patch(`/api/forms/submissions/${draft.id}`, {
    headers,
    data: {
      status: 'submitted',
      data: { riskTolerance: 'moderate', timeHorizon: '10y' }
    }
  });

  await page.getByRole('button', { name: 'Forms' }).click();
  await expect(page.locator('#view')).toContainText(template.id);
  await expect(page.locator('#view')).toContainText('submitted');
});

test('portal form supports draft and submit from browser', async ({ page, request }) => {
  await loginWithDemo(page);
  const headers = await authHeaders(page);

  const clientFirst = id('PortalClient');
  await request.post('/api/profiles', {
    headers,
    data: {
      kind: 'client',
      firstName: clientFirst,
      lastName: 'Tester',
      email: `${clientFirst}@example.test`
    }
  });

  const profiles = await (await request.get('/api/profiles?kind=client', { headers: { Authorization: headers.Authorization } })).json();
  const client = profiles.find((profile) => profile.firstName === clientFirst);

  const template = await (await request.post('/api/forms/templates', {
    headers,
    data: {
      name: id('PortalTemplate'),
      description: 'Portal completion',
      sections: [
        { title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] },
        { title: 'Accounts', repeatable: true, fields: [{ key: 'institution', label: 'Institution', type: 'text' }] }
      ]
    }
  })).json();

  const portal = await (await request.post('/api/portal-links', {
    headers,
    data: { profileId: client.id }
  })).json();

  await page.goto(`/portal?token=${portal.token}`);
  await expect(page.locator('#portal-subtitle')).toContainText(clientFirst);
  await page.locator('input[name="section-0::primaryGoal"]').fill('Retire comfortably');
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.locator('#portal-status')).toContainText('Draft saved');

  await page.locator('input[name="section-0::primaryGoal"]').fill('Retire very comfortably');
  await page.getByRole('button', { name: 'Submit Form' }).click();
  await expect(page.locator('#portal-status')).toContainText('Form submitted');
  await expect(page.locator('#portal-submissions')).toContainText(template.id);
  await expect(page.locator('#portal-submissions')).toContainText('submitted');
});

test('exports page shows completed job output visibility', async ({ page, request }) => {
  await loginWithDemo(page);
  const headers = await authHeaders(page);

  const clientFirst = id('ExportClient');
  const client = await (await request.post('/api/profiles', {
    headers,
    data: {
      kind: 'client',
      firstName: clientFirst,
      lastName: 'Tester',
      email: `${clientFirst}@example.test`
    }
  })).json();

  const docTemplate = await (await request.post('/api/templates', {
    headers,
    data: {
      name: id('ExportTemplate'),
      fileName: 'advice.pdf',
      blueprint: { sections: [] },
      mappings: []
    }
  })).json();

  await request.post('/api/exports', {
    headers,
    data: {
      clientId: client.id,
      templateId: docTemplate.id,
      type: 'pdf'
    }
  });
  await request.post('/api/exports/process', { headers: { Authorization: headers.Authorization } });

  await page.getByRole('button', { name: 'Exports' }).click();
  await expect(page.locator('#view')).toContainText('Exports');
  await expect(page.locator('#view')).toContainText('completed');
  await expect(page.locator('#view')).toContainText('fileName');
});
