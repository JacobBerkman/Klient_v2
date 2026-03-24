import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const port = 3011;

rmSync('data/app.db', { force: true });

const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(path = '/health', attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      if (response.ok) return;
    } catch {
      // keep retrying while server boots
    }
    await wait(150);
  }
  throw new Error('Server did not become ready in time');
}

async function requestJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  return { status: response.status, data };
}

function authHeader(token, includeJson = false) {
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`
  };
}

function assertStatus(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${expected}, received ${actual}`);
  }
}

async function login(email, password) {
  const response = await requestJson('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assertStatus(response.status, 200, `login ${email}`);
  return response.data;
}

async function run() {
  await waitForServer();

  const adminSession = await login('admin@demo.test', 'ChangeMe123!');
  const adminToken = adminSession.token;

  const inviteAdvisor = await requestJson('/api/invites', {
    method: 'POST',
    headers: authHeader(adminToken, true),
    body: JSON.stringify({ email: 'advisor@demo.test', role: 'advisor' })
  });
  assertStatus(inviteAdvisor.status, 201, 'admin invite advisor');

  const inviteReadonly = await requestJson('/api/invites', {
    method: 'POST',
    headers: authHeader(adminToken, true),
    body: JSON.stringify({ email: 'readonly@demo.test', role: 'readonly' })
  });
  assertStatus(inviteReadonly.status, 201, 'admin invite readonly');

  const inviteClient = await requestJson('/api/invites', {
    method: 'POST',
    headers: authHeader(adminToken, true),
    body: JSON.stringify({ email: 'client@demo.test', role: 'client' })
  });
  assertStatus(inviteClient.status, 201, 'admin invite client');

  const acceptAdvisor = await requestJson('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteAdvisor.data.token, firstName: 'Ada', lastName: 'Visor', password: 'Advisor123!' })
  });
  assertStatus(acceptAdvisor.status, 200, 'accept advisor invite');
  const advisorToken = acceptAdvisor.data.token;

  const acceptReadonly = await requestJson('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteReadonly.data.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' })
  });
  assertStatus(acceptReadonly.status, 200, 'accept readonly invite');
  const readonlyToken = acceptReadonly.data.token;

  const acceptClient = await requestJson('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteClient.data.token, firstName: 'Clara', lastName: 'Client', password: 'Client123!' })
  });
  assertStatus(acceptClient.status, 200, 'accept client invite');
  const clientToken = acceptClient.data.token;

  const readonlyCreateProfile = await requestJson('/api/profiles', {
    method: 'POST',
    headers: authHeader(readonlyToken, true),
    body: JSON.stringify({ kind: 'prospect', firstName: 'No', lastName: 'Write' })
  });
  assertStatus(readonlyCreateProfile.status, 403, 'readonly write denied');

  const clientListProfiles = await requestJson('/api/profiles', { headers: authHeader(clientToken) });
  assertStatus(clientListProfiles.status, 403, 'client denied advisor route');

  const clientListUsers = await requestJson('/api/users', { headers: authHeader(clientToken) });
  assertStatus(clientListUsers.status, 403, 'client denied admin route');

  const advisorInviteUser = await requestJson('/api/invites', {
    method: 'POST',
    headers: authHeader(advisorToken, true),
    body: JSON.stringify({ email: 'blocked@demo.test', role: 'readonly' })
  });
  assertStatus(advisorInviteUser.status, 403, 'advisor denied admin-only invite');

  const advisorProcessExports = await requestJson('/api/exports/process', {
    method: 'POST',
    headers: authHeader(advisorToken)
  });
  assertStatus(advisorProcessExports.status, 403, 'advisor denied admin-only export processing');

  const adminProfiles = await requestJson('/api/profiles', { headers: authHeader(adminToken) });
  const adminHouseholds = await requestJson('/api/households', { headers: authHeader(adminToken) });
  const adminForms = await requestJson('/api/forms/templates', { headers: authHeader(adminToken) });
  const adminSubmissions = await requestJson('/api/forms/submissions', { headers: authHeader(adminToken) });
  const adminTemplates = await requestJson('/api/templates', { headers: authHeader(adminToken) });
  const adminExports = await requestJson('/api/exports', { headers: authHeader(adminToken) });
  const adminAudit = await requestJson('/api/audit', { headers: authHeader(adminToken) });
  const adminAnalytics = await requestJson('/api/analytics', { headers: authHeader(adminToken) });
  const adminUsers = await requestJson('/api/users', { headers: authHeader(adminToken) });

  for (const [label, response] of [
    ['admin profiles', adminProfiles],
    ['admin households', adminHouseholds],
    ['admin form templates', adminForms],
    ['admin form submissions', adminSubmissions],
    ['admin templates', adminTemplates],
    ['admin exports', adminExports],
    ['admin audit', adminAudit],
    ['admin analytics', adminAnalytics],
    ['admin users', adminUsers]
  ]) {
    assertStatus(response.status, 200, label);
  }

  console.log(JSON.stringify({
    readonlyWriteStatus: readonlyCreateProfile.status,
    clientAdvisorRouteStatus: clientListProfiles.status,
    clientAdminRouteStatus: clientListUsers.status,
    advisorInviteStatus: advisorInviteUser.status,
    advisorProcessExportsStatus: advisorProcessExports.status,
    adminAccessChecks: 9
  }, null, 2));
}

run()
  .finally(() => {
    server.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
