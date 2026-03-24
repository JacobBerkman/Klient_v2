import { assert, createTestContext } from './test-harness.mjs';

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
const context = await createTestContext('smoke');

try {
  await context.request('/health');
  await context.request('/ready');
  const login = await context.login();

const authState = { token: '' };
const api = createJsonApiClient({
  getToken: () => authState.token,
  fetchImpl: (path, options) => fetch(`http://127.0.0.1:${port}${path}`, options)
});

async function run() {
  const ready = await api('/ready');
  if (!ready.querySummary) throw new Error('Readiness summary missing');
  if (!ready.storageHealth?.connected) throw new Error('Storage health missing');
  if (!ready.exportWorker) throw new Error('Export worker diagnostics missing');

  const login = await api(routes.login(), {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  const login = await jsonFetch('/api/login', {
  const headers = context.authHeaders(login.token);
  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Smoke',
      lastName: 'Path',
      email: `smoke.path+${Date.now()}@example.com`,
      stage: 'discovery'
    })
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
  const client = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'client',
      firstName: 'House',
      lastName: 'Hold',
      email: `house.hold+${Date.now()}@example.com`,
      phone: '555-202-3030',
      taxId: '99887766'
    })
  });

  const foundProfiles = await context.request('/api/profiles?search=Smoke', { headers: { Authorization: `Bearer ${login.token}` } });
  assert(foundProfiles.some((entry) => entry.id === profile.id), 'Search failed');

  const note = await context.request(`/api/profiles/${profile.id}/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body: 'Smoke test note' })
  });

  const household = await jsonFetch('/api/households', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Smoke Household', primaryClientId: client.id }) });
  await jsonFetch(`/api/households/${household.id}/members`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ clientId: profile.id, role: 'member' }) });
  const spouse = await jsonFetch('/api/households/create-spouse', { method: 'POST', headers: authHeaders, body: JSON.stringify({ primaryClientId: client.id, spouse: { firstName: 'Sam', lastName: 'Hold', email: 'sam@example.com', phone: '555-444-5555' } }) });
  await jsonFetch(`/api/households/${household.id}/members`, { method: 'DELETE', headers: authHeaders, body: JSON.stringify({ clientId: profile.id }) });
  const invite = await jsonFetch('/api/invites', { method: 'POST', headers: authHeaders, body: JSON.stringify({ email: 'readonly@test.local', role: 'readonly' }) });
  const readonlySession = await jsonFetch('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' }) });
  const clientInvite = await jsonFetch('/api/invites', { method: 'POST', headers: authHeaders, body: JSON.stringify({ email: 'morgan@example.com', role: 'client' }) });
  const clientSession = await jsonFetch('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: clientInvite.token, firstName: 'Morgan', lastName: 'Taylor', password: 'Client123!' }) });
  const reset = await jsonFetch('/api/password-resets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'readonly@test.local' }) });
  await jsonFetch('/api/password-resets/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.token, password: 'Readonly456!' }) });
  const household = await context.request('/api/households', { method: 'POST', headers, body: JSON.stringify({ name: 'Smoke Household', primaryClientId: client.id }) });
  await context.request(`/api/households/${household.id}/members`, { method: 'POST', headers, body: JSON.stringify({ clientId: profile.id, role: 'member' }) });
  const spouse = await context.request('/api/households/create-spouse', { method: 'POST', headers, body: JSON.stringify({ primaryClientId: client.id, spouse: { firstName: 'Sam', lastName: 'Hold', email: `sam.hold+${Date.now()}@example.com`, phone: '555-444-5555' } }) });
  await context.request(`/api/households/${household.id}/members`, { method: 'DELETE', headers, body: JSON.stringify({ clientId: profile.id }) });

  const invite = await context.request('/api/invites', { method: 'POST', headers, body: JSON.stringify({ email: `readonly+${Date.now()}@test.local`, role: 'readonly' }) });
  const readonlySession = await context.request('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' }) });
  const reset = await context.request('/api/password-resets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: readonlySession.user.email }) });
  await context.request('/api/password-resets/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.token, password: 'Readonly456!' }) });

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
  const portalData = await jsonFetch(`/api/portal/${portal.token}`);
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Retire early' } }) });
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'submitted', data: { primaryGoal: 'Retire early', accounts: [{ institution: 'Vanguard', balance: '120000' }] } }) });
  await jsonFetch(`/api/portal/${portal.token}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '2025 Tax Return', category: 'tax' }) });
  const refreshedPortalData = await jsonFetch(`/api/portal/${portal.token}`);

  const deniedClientProfiles = await fetch(`http://127.0.0.1:${port}/api/profiles`, { headers: { Authorization: `Bearer ${clientSession.token}` } });
  if (deniedClientProfiles.status !== 401) throw new Error('Client should not access advisor profiles endpoint');
  const clientWorkspace = await jsonFetch('/api/client/workspace', { headers: { Authorization: `Bearer ${clientSession.token}` } });
  await jsonFetch('/api/client/forms/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientSession.token}` }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Client draft' } }) });
  await jsonFetch('/api/client/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientSession.token}` }, body: JSON.stringify({ name: 'Passport', category: 'identification' }) });

  const exportJob = await jsonFetch('/api/exports', { method: 'POST', headers: authHeaders, body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' }) });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch(`/api/exports/${exportJob.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  const exportsList = await jsonFetch('/api/exports', { headers: { Authorization: `Bearer ${login.token}` } });

  const drafts = await jsonFetch('/api/forms/drafts', { headers: { Authorization: `Bearer ${login.token}` } });
  const analytics = await jsonFetch('/api/analytics', { headers: { Authorization: `Bearer ${login.token}` } });
  const detail = await jsonFetch(`/api/profiles/${client.id}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const households = await jsonFetch('/api/households', { headers: { Authorization: `Bearer ${login.token}` } });
  const masked = await jsonFetch(`/api/profiles/${client.id}/sensitive`, { headers: { Authorization: `Bearer ${login.token}` } });
  const dashboard = await jsonFetch('/api/dashboard', { headers: { Authorization: `Bearer ${login.token}` } });
  const diagnostics = await jsonFetch('/api/ops/diagnostics', { headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  if (!analytics.stageCounts) throw new Error('Analytics missing');
  if (!portalData.availableTemplates.find((entry) => entry.id === portalTemplate.id)) throw new Error('Portal templates missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'draft')) throw new Error('Portal draft missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'submitted')) throw new Error('Portal submission missing');
  if (!refreshedPortalData.uploads.find((entry) => entry.name === '2025 Tax Return')) throw new Error('Portal upload missing');
  if (!exportsList.find((job) => job.id === exportJob.id && job.status === 'completed')) throw new Error('Export processing failed');
  if (!detail.household || detail.householdMembers.length < 2 || !detail.profileRecord) throw new Error('Profile detail failed');
  if (!households.find((entry) => entry.id === household.id)) throw new Error('Household list failed');
  if (!masked.taxIdMasked) throw new Error('Sensitive masking failed');
  if (readonlySession.user.role !== 'readonly') throw new Error('Invite acceptance failed');
  if (clientSession.user.role !== 'client') throw new Error('Client invite acceptance failed');
  if (!clientWorkspace.templateProgress.some((entry) => entry.templateId === portalTemplate.id)) throw new Error('Client workspace missing template progress');
  if (published.status !== 'published') throw new Error('Template publish failed');
  if (!diagnostics.data?.audit?.total) throw new Error('Ops diagnostics audit summary missing');
  if (!diagnostics.data?.storageHealth?.connected) throw new Error('Ops diagnostics storage summary missing');
  const template = await context.request('/api/templates/auto-build', { method: 'POST', headers, body: JSON.stringify({ name: 'Auto Build Test', fields: ['client.name', 'client.address', 'assets.account'] }) });
  const published = await context.request(`/api/templates/${template.id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  const portal = await context.request('/api/portal-links', { method: 'POST', headers, body: JSON.stringify({ profileId: profile.id }) });
  const portalTemplate = await context.request('/api/forms/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Portal Intake',
      description: 'Client-completed discovery questions',
      sections: [
        { title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] },
        { title: 'Accounts', repeatable: true, fields: [{ key: 'institution', label: 'Institution', type: 'text' }, { key: 'balance', label: 'Balance', type: 'number' }] }
      ]
    })
  });
  const portalData = await context.request(`/api/portal/${portal.token}`);
  await context.request(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Retire early' } }) });
  await context.request(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'submitted', data: { primaryGoal: 'Retire early', accounts: [{ institution: 'Vanguard', balance: '120000' }] } }) });
  const refreshedPortalData = await context.request(`/api/portal/${portal.token}`);

  const exportJob = await context.request('/api/exports', { method: 'POST', headers, body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' }) });
  await context.request('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await context.request(`/api/exports/${exportJob.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await context.request('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  const exportsList = await context.request('/api/exports', { headers: { Authorization: `Bearer ${login.token}` } });

  const drafts = await context.request('/api/forms/drafts', { headers: { Authorization: `Bearer ${login.token}` } });
  const analytics = await context.request('/api/analytics', { headers: { Authorization: `Bearer ${login.token}` } });
  const detail = await context.request(`/api/profiles/${client.id}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const households = await context.request('/api/households', { headers: { Authorization: `Bearer ${login.token}` } });
  const masked = await context.request(`/api/profiles/${client.id}/sensitive`, { headers: { Authorization: `Bearer ${login.token}` } });
  const dashboard = await context.request('/api/dashboard', { headers: { Authorization: `Bearer ${login.token}` } });
  await context.request('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  assert(analytics.stageCounts, 'Analytics missing');
  assert(portalData.availableTemplates.some((entry) => entry.id === portalTemplate.id), 'Portal templates missing');
  assert(refreshedPortalData.submissions.some((entry) => entry.status === 'draft'), 'Portal draft missing');
  assert(refreshedPortalData.submissions.some((entry) => entry.status === 'submitted'), 'Portal submission missing');
  assert(exportsList.some((job) => job.id === exportJob.id && job.status === 'completed'), 'Export processing failed');
  assert(detail.household && detail.householdMembers.length >= 2 && detail.profileRecord, 'Profile detail failed');
  assert(households.some((entry) => entry.id === household.id), 'Household list failed');
  assert(masked.taxIdMasked, 'Sensitive masking failed');
  assert(readonlySession.user.role === 'readonly', 'Invite acceptance failed');
  assert(published.status === 'published', 'Template publish failed');

  console.log(JSON.stringify({
    suite: 'smoke',
    user: login.user.email,
    profileId: profile.id,
    noteId: note.id,
    householdId: household.id,
    spouseId: spouse.id,
    inviteRole: readonlySession.user.role,
    clientRole: clientSession.user.role,
    draftCount: drafts.length,
    exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
    totalProfiles: dashboard.stats.totalProfiles,
    templateStatus: published.status,
    unauthorizedStatus: unauthorizedError.status
    diagnosticsAuditTotal: diagnostics.data.audit.total
  }, null, 2));
} finally {
  await context.shutdown();
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
