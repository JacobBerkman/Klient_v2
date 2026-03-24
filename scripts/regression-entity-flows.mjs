import { spawn } from 'node:child_process';

const port = 3011;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: ${data.message || 'Request failed'}`);
  }
  return data;
}

async function run() {
  await wait(700);

  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

  // Profiles regression: create + update + stage move
  const profile = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Repo',
      lastName: 'Regression',
      email: 'repo-regression@example.test',
      stage: 'discovery',
      source: { cityOrLocation: 'Austin', venue: 'Workshop', occurredOn: '2026-03-24' }
    })
  });
  const updated = await jsonFetch(`/api/profiles/${profile.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ phone: '555-987-0000' })
  });
  const moved = await jsonFetch(`/api/profiles/${profile.id}/stage`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ stage: 'analysis' })
  });

  // Households regression: create + add/remove member
  const household = await jsonFetch('/api/households', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Regression Household', primaryClientId: profile.id })
  });
  const spouse = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'client', firstName: 'Taylor', lastName: 'Partner', email: 'taylor.partner@example.test' })
  });
  await jsonFetch(`/api/households/${household.id}/members`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: spouse.id, role: 'spouse' })
  });
  await jsonFetch(`/api/households/${household.id}/members`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ clientId: spouse.id })
  });
  const households = await jsonFetch('/api/households', { headers: { Authorization: `Bearer ${login.token}` } });

  // Forms regression: template + draft + submit list
  const formTemplate = await jsonFetch('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Regression Form', description: 'Repo test', sections: [{ title: 'Goals', fields: [{ key: 'goal', label: 'Goal', type: 'text' }] }] })
  });
  const draft = await jsonFetch('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: formTemplate.id, status: 'draft', data: { goal: 'test' } })
  });
  await jsonFetch(`/api/forms/submissions/${draft.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'submitted' })
  });
  const submissions = await jsonFetch('/api/forms/submissions', { headers: { Authorization: `Bearer ${login.token}` } });

  // Templates regression: create + mappings + publish
  const documentTemplate = await jsonFetch('/api/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Regression Doc Template', fileName: 'regression.pdf', blueprint: { sections: ['profile'] }, mappings: [] })
  });
  const mapped = await jsonFetch(`/api/templates/${documentTemplate.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mappings: [{ pdfField: 'client_name', sourcePath: 'profile.firstName' }] })
  });
  const published = await jsonFetch(`/api/templates/${documentTemplate.id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  // Exports regression: create + process + retry + process
  const exportJob = await jsonFetch('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: documentTemplate.id, type: 'pdf' })
  });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch(`/api/exports/${exportJob.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  const exportsList = await jsonFetch('/api/exports', { headers: { Authorization: `Bearer ${login.token}` } });

  if (updated.phone !== '555-987-0000') throw new Error('Profile update regression failed');
  if (moved.stage !== 'analysis') throw new Error('Profile stage move regression failed');
  if (!households.find((entry) => entry.id === household.id)) throw new Error('Household create regression failed');
  if (!submissions.find((entry) => entry.id === draft.id && entry.status === 'submitted')) throw new Error('Form submission regression failed');
  if (!mapped.versions || mapped.versions.length < 2 || published.status !== 'published') throw new Error('Template regression failed');
  if (!exportsList.find((entry) => entry.id === exportJob.id && entry.status === 'completed')) throw new Error('Export regression failed');

  console.log(JSON.stringify({
    profileId: profile.id,
    householdId: household.id,
    formTemplateId: formTemplate.id,
    documentTemplateId: documentTemplate.id,
    exportJobId: exportJob.id,
    exportStatus: exportsList.find((entry) => entry.id === exportJob.id)?.status
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
