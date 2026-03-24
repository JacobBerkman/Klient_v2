import { spawn } from 'node:child_process';

import { createJsonApiClient, decodeJsonResponse, routes } from '../apps/web/public/api-contract.js';

const port = 3010;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawJsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

const authState = { token: '' };
const api = createJsonApiClient({
  getToken: () => authState.token,
  fetchImpl: (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options)
});

async function run() {
  const ready = await api('/ready');
  if (!ready.querySummary) throw new Error('Readiness summary missing');

  const login = await api(routes.login(), {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  authState.token = login.token;

  const profile = await api(routes.profiles(), {
    method: 'POST',
    body: JSON.stringify({ kind: 'prospect', firstName: 'Smoke', lastName: 'Test', email: 'smoke@example.com', stage: 'discovery', ssn: '123456789' })
  });

  const foundProfiles = await api(routes.profiles({ search: 'Smoke' }));
  if (!foundProfiles.find((entry) => entry.id === profile.id)) throw new Error('Search failed');

  const note = await api(routes.profileNotes(profile.id), {
    method: 'POST',
    body: JSON.stringify({ body: 'Smoke test note' })
  });

  const invite = await api(routes.invites(), { method: 'POST', body: JSON.stringify({ email: 'readonly@test.local', role: 'readonly' }) });
  const readonlySession = await api('/api/invites/accept', { method: 'POST', body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' }) });
  const reset = await api('/api/password-resets', { method: 'POST', body: JSON.stringify({ email: 'readonly@test.local' }) });
  await api('/api/password-resets/confirm', { method: 'POST', body: JSON.stringify({ token: reset.token, password: 'Readonly456!' }) });

  const template = await api('/api/templates/auto-build', { method: 'POST', body: JSON.stringify({ name: 'Auto Build Test', fields: ['client.name', 'client.address', 'assets.account'] }) });
  const published = await api(`/api/templates/${template.id}/publish`, { method: 'POST' });

  const portal = await api(routes.portalLinks(), { method: 'POST', body: JSON.stringify({ profileId: profile.id }) });
  const portalTemplate = await api(routes.formTemplates(), { method: 'POST', body: JSON.stringify({
    name: 'Portal Intake',
    description: 'Client-completed discovery questions',
    sections: [
      { title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] },
      { title: 'Accounts', repeatable: true, fields: [{ key: 'institution', label: 'Institution', type: 'text' }, { key: 'balance', label: 'Balance', type: 'number' }] }
    ]
  }) });
  const portalData = await api(routes.portal(portal.token));
  await api(routes.portalSubmissions(portal.token), { method: 'POST', body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Retire early' } }) });
  await api(routes.portalSubmissions(portal.token), { method: 'POST', body: JSON.stringify({ templateId: portalTemplate.id, status: 'submitted', data: { primaryGoal: 'Retire early', accounts: [{ institution: 'Vanguard', balance: '120000' }] } }) });
  const refreshedPortalData = await api(routes.portal(portal.token));

  const exportJob = await api(routes.exports(), { method: 'POST', body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' }) });
  await api('/api/exports/process', { method: 'POST' });
  await api(`/api/exports/${exportJob.id}/retry`, { method: 'POST' });
  await api('/api/exports/process', { method: 'POST' });
  const exportsList = await api(routes.exports());

  const drafts = await api(routes.formDrafts());
  const analytics = await api(routes.analytics());
  const detail = await api(routes.profileDetail(profile.id));
  const dashboard = await api(routes.dashboard());
  await api('/api/logout', { method: 'POST' });

  const unauthorized = await rawJsonFetch(routes.dashboard());
  let unauthorizedError;
  try {
    decodeJsonResponse(unauthorized.response, unauthorized.body);
  } catch (error) {
    unauthorizedError = error;
  }

  if (!unauthorizedError || unauthorizedError.status !== 401 || !unauthorized.body?.error?.requestId) throw new Error('Normalized error contract missing');
  if (!analytics.stageCounts) throw new Error('Analytics missing');
  if (!portalData.availableTemplates.find((entry) => entry.id === portalTemplate.id)) throw new Error('Portal templates missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'draft')) throw new Error('Portal draft missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'submitted')) throw new Error('Portal submission missing');
  if (!exportsList.find((job) => job.id === exportJob.id && job.status === 'completed')) throw new Error('Export processing failed');
  if (!detail.notes.length || !detail.profileRecord) throw new Error('Profile detail failed');
  if (readonlySession.user.role !== 'readonly') throw new Error('Invite acceptance failed');
  if (published.status !== 'published') throw new Error('Template publish failed');

  console.log(JSON.stringify({
    login: login.user.email,
    profileId: profile.id,
    noteId: note.id,
    inviteRole: readonlySession.user.role,
    draftCount: drafts.length,
    exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
    totalProfiles: dashboard.stats.totalProfiles,
    templateStatus: published.status,
    unauthorizedStatus: unauthorizedError.status
  }, null, 2));
}

await wait(700);
run()
  .finally(() => {
    server.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
