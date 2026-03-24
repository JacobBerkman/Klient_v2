import assert from 'node:assert/strict';
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
  const data = await response.json();
  return { response, data };
}

async function jsonFetch(path, options = {}) {
  const { response, data } = await request(path, options);
  if (!response.ok) throw new Error(`${path}: ${data.message || 'Request failed'}`);
  return data;
}

async function run() {
  await wait(700);
  await jsonFetch('/ready');

  const admin = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` };

  const invite = await jsonFetch('/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: 'morgan@example.com', role: 'client' })
  });

  const client = await jsonFetch('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Morgan', lastName: 'Taylor', password: 'Client123!' })
  });
  const clientHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${client.token}` };

  const denied = await request('/api/profiles', { headers: { Authorization: `Bearer ${client.token}` } });
  assert.equal(denied.response.status, 401, 'client role must not access advisor profile list');

  const template = await jsonFetch('/api/forms/templates', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      name: 'Client Restricted Form',
      description: 'Role visibility test',
      sections: [{ title: 'Goals', fields: [{ key: 'goal', label: 'Goal', type: 'text' }] }]
    })
  });

  const workspace = await jsonFetch('/api/client/workspace', { headers: { Authorization: `Bearer ${client.token}` } });
  assert.equal(workspace.profile.email, 'morgan@example.com');
  assert.ok(workspace.templateProgress.some((item) => item.templateId === template.id && item.status === 'not_started'));

  const clientDraft = await jsonFetch('/api/client/forms/submissions', {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ templateId: template.id, status: 'draft', data: { goal: 'Retire by 60' } })
  });
  assert.equal(clientDraft.source, 'client_portal');

  const clientUpload = await jsonFetch('/api/client/uploads', {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ name: 'Passport Copy', category: 'identification' })
  });
  assert.equal(clientUpload.uploadedBy, 'client');

  const portalLink = await jsonFetch('/api/portal-links', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ profileId: workspace.profile.id })
  });
  await jsonFetch(`/api/portal/${portalLink.token}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Portal W-2', category: 'tax' })
  });

  const portalData = await jsonFetch(`/api/portal/${portalLink.token}`);
  assert.ok(portalData.uploads.some((upload) => upload.name === 'Portal W-2' && upload.uploadedBy === 'portal'));

  console.log(JSON.stringify({
    roleRestrictionStatus: denied.response.status,
    workspaceTemplates: workspace.templateProgress.length,
    clientSubmission: clientDraft.id,
    clientUpload: clientUpload.id,
    portalUploads: portalData.uploads.length
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
