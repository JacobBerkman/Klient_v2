import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('smoke');

try {
  await context.request('/health');
  await context.request('/ready');
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

  const household = await context.request('/api/households', { method: 'POST', headers, body: JSON.stringify({ name: 'Smoke Household', primaryClientId: client.id }) });
  await context.request(`/api/households/${household.id}/members`, { method: 'POST', headers, body: JSON.stringify({ clientId: profile.id, role: 'member' }) });
  const spouse = await context.request('/api/households/create-spouse', { method: 'POST', headers, body: JSON.stringify({ primaryClientId: client.id, spouse: { firstName: 'Sam', lastName: 'Hold', email: `sam.hold+${Date.now()}@example.com`, phone: '555-444-5555' } }) });
  await context.request(`/api/households/${household.id}/members`, { method: 'DELETE', headers, body: JSON.stringify({ clientId: profile.id }) });

  const invite = await context.request('/api/invites', { method: 'POST', headers, body: JSON.stringify({ email: `readonly+${Date.now()}@test.local`, role: 'readonly' }) });
  const readonlySession = await context.request('/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' }) });
  const reset = await context.request('/api/password-resets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: readonlySession.user.email }) });
  await context.request('/api/password-resets/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reset.token, password: 'Readonly456!' }) });

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
    draftCount: drafts.length,
    exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
    totalProfiles: dashboard.stats.totalProfiles,
    templateStatus: published.status
  }, null, 2));
} finally {
  await context.shutdown();
}
