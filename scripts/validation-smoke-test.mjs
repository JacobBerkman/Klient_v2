import { spawn } from 'node:child_process';

const port = 3011;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { status: response.status, data };
}

function expectValidation(result, label) {
  if (result.status !== 422) {
    throw new Error(`${label}: expected status 422, got ${result.status}`);
  }
  if (result.data?.error?.code !== 'invalid_request') {
    throw new Error(`${label}: expected invalid_request code`);
  }
}

async function run() {
  await wait(700);

  const badRegister = await request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'missing-required-fields@example.com' })
  });
  expectValidation(badRegister, 'register');

  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  if (login.status !== 200 || !login.data.token) throw new Error('failed to login for validation tests');
  const auth = { Authorization: `Bearer ${login.data.token}`, 'Content-Type': 'application/json' };

  const badInviteAccept = await request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'missing-user-data' })
  });
  expectValidation(badInviteAccept, 'invite accept');

  const badPasswordReset = await request('/api/password-resets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  expectValidation(badPasswordReset, 'password reset request');

  const badProfileCreate = await request('/api/profiles', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kind: 'prospect', firstName: 'OnlyName' })
  });
  expectValidation(badProfileCreate, 'profile create');

  const badStageMove = await request('/api/profiles/unknown/stage', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({})
  });
  expectValidation(badStageMove, 'stage move');

  const badHouseholdAdd = await request('/api/households/unknown/members', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientId: 'abc' })
  });
  expectValidation(badHouseholdAdd, 'household member add');

  const badLinkSpouse = await request('/api/households/link-spouse', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ primaryClientId: 'x' })
  });
  expectValidation(badLinkSpouse, 'link spouse');

  const badTemplateCreate = await request('/api/templates', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ mappings: [] })
  });
  expectValidation(badTemplateCreate, 'template create');

  const badSubmissionCreate = await request('/api/forms/submissions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientId: 'x' })
  });
  expectValidation(badSubmissionCreate, 'form submission create');

  const badPortal = await request('/api/portal/fake/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'invalid' })
  });
  expectValidation(badPortal, 'portal submission');

  const badExport = await request('/api/exports', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ clientId: 'x' })
  });
  expectValidation(badExport, 'export create');

  console.log(JSON.stringify({
    checked: [
      'register/login',
      'invite accept',
      'password reset',
      'profile create/stage move',
      'household member + spouse endpoints',
      'template + form submissions',
      'portal submission',
      'export creation'
    ],
    errorShape: badRegister.data
  }, null, 2));
}

run()
  .finally(() => server.kill('SIGTERM'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
