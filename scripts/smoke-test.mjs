import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('smoke');

try {
  const health = await context.request('/health');
  const ready = await context.request('/ready');
  const login = await context.login();

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

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const profile = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Smoke', lastName: 'Test', email: 'smoke@example.com', stage: 'discovery', ssn: '123456789' })
  });
  const client = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'House', lastName: 'Hold', email: 'house@example.com', phone: '555-202-3030', taxId: '99887766' })
  });

  const foundProfiles = await jsonFetch('/api/profiles?search=Smoke', { headers: { Authorization: `Bearer ${login.token}` } });
  if (!foundProfiles.find((entry) => entry.id === profile.id)) throw new Error('Search failed');

  const note = await jsonFetch(`/api/profiles/${profile.id}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ body: 'Smoke test note' })
  });

  const household = await jsonFetch('/api/households', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Smoke Household', primaryClientId: client.id }) });
  await jsonFetch(`/api/households/${household.id}/members`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ clientId: profile.id, role: 'member' }) });
  const spouse = await jsonFetch('/api/households/create-spouse', { method: 'POST', headers: authHeaders, body: JSON.stringify({ primaryClientId: client.id, spouse: { firstName: 'Sam', lastName: 'Hold', email: 'sam@example.com', phone: '555-444-5555' } }) });
  await jsonFetch(`/api/households/${household.id}/members`, { method: 'DELETE', headers: authHeaders, body: JSON.stringify({ clientId: profile.id }) });
  const invite = await jsonFetch('/api/invites', { method: 'POST', headers: authHeaders, body: JSON.stringify({ email: 'readonly@test.local', role: 'readonly' }) });
  const readonlySession = await jsonFetch('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' }) });
  const reset = await jsonFetch('/api/password-resets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'readonly@test.local' }) });
  await jsonFetch('/api/password-resets/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.token, password: 'Readonly456!' }) });

  const template = await jsonFetch('/api/templates/auto-build', { method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Auto Build Test', fields: ['client.name', 'client.address', 'assets.account'] }) });
  const published = await jsonFetch(`/api/templates/${template.id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  const portal = await jsonFetch('/api/portal-links', { method: 'POST', headers: authHeaders, body: JSON.stringify({ profileId: profile.id }) });
  const portalTemplate = await jsonFetch('/api/forms/templates', { method: 'POST', headers: authHeaders, body: JSON.stringify({
    name: 'Portal Intake',
    description: 'Client-completed discovery questions',
    sections: [
      { title: 'Goals', fields: [{ key: 'primaryGoal', label: 'Primary Goal', type: 'text' }] },
      { title: 'Accounts', repeatable: true, fields: [{ key: 'institution', label: 'Institution', type: 'text' }, { key: 'balance', label: 'Balance', type: 'number' }] }
    ]
  }) });
  const portalData = await jsonFetch(`/api/portal/${portal.token}`);
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Retire early' } }) });
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'submitted', data: { primaryGoal: 'Retire early', accounts: [{ institution: 'Vanguard', balance: '120000' }] } }) });
  const refreshedPortalData = await jsonFetch(`/api/portal/${portal.token}`);

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
  await jsonFetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  if (!analytics.stageCounts) throw new Error('Analytics missing');
  if (!portalData.availableTemplates.find((entry) => entry.id === portalTemplate.id)) throw new Error('Portal templates missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'draft')) throw new Error('Portal draft missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'submitted')) throw new Error('Portal submission missing');
  if (!exportsList.find((job) => job.id === exportJob.id && job.status === 'completed')) throw new Error('Export processing failed');
  if (!detail.household || detail.householdMembers.length < 2 || !detail.profileRecord) throw new Error('Profile detail failed');
  if (!households.find((entry) => entry.id === household.id)) throw new Error('Household list failed');
  if (!masked.taxIdMasked) throw new Error('Sensitive masking failed');
  if (readonlySession.user.role !== 'readonly') throw new Error('Invite acceptance failed');
  if (published.status !== 'published') throw new Error('Template publish failed');

  console.log(JSON.stringify({
    suite: 'smoke',
    user: login.user.email,
    profileId: profile.id,
    noteId: note.id,
    householdId: household.id,
    spouseId: spouse.id,
    inviteRole: readonlySession.user.role,
    draftCount: drafts.length,
    exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
    totalProfiles: dashboard.stats.totalProfiles,
    templateStatus: published.status
  }, null, 2));
} finally {
  await context.shutdown();
}
