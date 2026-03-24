import { spawn } from 'node:child_process';

const port = 3010;
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
  if (!response.ok) throw new Error(`${path}: ${data.message || 'Request failed'}`);
  return data;
}

async function run() {
  await wait(700);
  const ready = await jsonFetch('/ready');
  if (!ready.querySummary) throw new Error('Readiness summary missing');

  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const profile = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Smoke', lastName: 'Test', email: 'smoke@example.com', stage: 'discovery', ssn: '123456789' })
  });
  await jsonFetch('/api/households', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Smoke Household', primaryClientId: profile.id })
  });

  const foundProfiles = await jsonFetch('/api/profiles?search=Smoke', { headers: { Authorization: `Bearer ${login.token}` } });
  if (!foundProfiles.find((entry) => entry.id === profile.id)) throw new Error('Search failed');

  const note = await jsonFetch(`/api/profiles/${profile.id}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ body: 'Smoke test note' })
  });

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
  const advisorIntakeTemplate = await jsonFetch('/api/forms/templates', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Advisor Intake',
      description: 'Advisor-facing intake leveraging client portal answers',
      sections: [
        {
          title: 'Client Basics',
          fields: [
            { key: 'firstName', label: 'First Name', type: 'text' },
            { key: 'householdName', label: 'Household Name', type: 'text' },
            { key: 'goals', label: 'Goals', type: 'textarea' },
            { key: 'riskTolerance', label: 'Risk Tolerance', type: 'text' }
          ]
        }
      ],
      equivalentFieldMappings: [
        { fromTemplateId: portalTemplate.id, fromField: 'primaryGoal', toField: 'goals' },
        { fromTemplateId: portalTemplate.id, fromField: 'riskProfile', toField: 'riskTolerance' }
      ]
    })
  });
  const portalData = await jsonFetch(`/api/portal/${portal.token}`);
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'draft', data: { primaryGoal: 'Retire early' } }) });
  await jsonFetch(`/api/portal/${portal.token}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: portalTemplate.id, status: 'submitted', data: { primaryGoal: 'Retire early', riskProfile: 'Moderate', accounts: [{ institution: 'Vanguard', balance: '120000' }] } }) });
  const refreshedPortalData = await jsonFetch(`/api/portal/${portal.token}`);
  const prepopulation = await jsonFetch(`/api/forms/prepopulation?clientId=${encodeURIComponent(profile.id)}&templateId=${encodeURIComponent(advisorIntakeTemplate.id)}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const reusedDraft = await jsonFetch('/api/forms/submissions', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: advisorIntakeTemplate.id,
      status: 'draft',
      reuse: { enabled: true }
    })
  });

  const exportJob = await jsonFetch('/api/exports', { method: 'POST', headers: authHeaders, body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' }) });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch(`/api/exports/${exportJob.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });
  const exportsList = await jsonFetch('/api/exports', { headers: { Authorization: `Bearer ${login.token}` } });

  const drafts = await jsonFetch('/api/forms/drafts', { headers: { Authorization: `Bearer ${login.token}` } });
  const analytics = await jsonFetch('/api/analytics', { headers: { Authorization: `Bearer ${login.token}` } });
  const detail = await jsonFetch(`/api/profiles/${profile.id}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const dashboard = await jsonFetch('/api/dashboard', { headers: { Authorization: `Bearer ${login.token}` } });
  await jsonFetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.token}` } });

  if (!analytics.stageCounts) throw new Error('Analytics missing');
  if (!portalData.availableTemplates.find((entry) => entry.id === portalTemplate.id)) throw new Error('Portal templates missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'draft')) throw new Error('Portal draft missing');
  if (!refreshedPortalData.submissions.find((entry) => entry.status === 'submitted')) throw new Error('Portal submission missing');
  if (!exportsList.find((job) => job.id === exportJob.id && job.status === 'completed')) throw new Error('Export processing failed');
  if (!detail.notes.length || !detail.profileRecord) throw new Error('Profile detail failed');
  if (readonlySession.user.role !== 'readonly') throw new Error('Invite acceptance failed');
  if (published.status !== 'published') throw new Error('Template publish failed');
  if (prepopulation.data.firstName !== 'Smoke') throw new Error('Profile prepopulation missing');
  if (!prepopulation.data.householdName) throw new Error('Household prepopulation missing');
  if (prepopulation.data.goals !== 'Retire early') throw new Error('Mapped equivalent prepopulation missing');
  if (!prepopulation.reuseLog.find((entry) => entry.field === 'goals' && entry.source?.type === 'mapped_equivalent')) throw new Error('Mapped equivalent source metadata missing');
  if (!reusedDraft.reuseLog.length || reusedDraft.data.riskTolerance !== 'Moderate') throw new Error('Submission reuse application failed');

  console.log(JSON.stringify({
    login: login.user.email,
    profileId: profile.id,
    noteId: note.id,
    inviteRole: readonlySession.user.role,
    draftCount: drafts.length,
    reusedFieldCount: reusedDraft.reuseLog.length,
    exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
    totalProfiles: dashboard.stats.totalProfiles,
    templateStatus: published.status
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
