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

  const repeatableTemplate = await jsonFetch('/api/forms/templates', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'Repeatable Edit Smoke',
      description: 'Template used for repeatable edit coverage',
      sections: [{ title: 'Assets', repeatable: true, fields: [{ key: 'accountName', label: 'Account Name', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }] }]
    })
  });
  const repeatableSubmission = await jsonFetch('/api/forms/submissions', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: profile.id, templateId: repeatableTemplate.id, status: 'submitted', data: { assets: [{ accountName: 'Brokerage', value: 5000 }] } })
  });
  const profileWithSubmission = await jsonFetch(`/api/profiles/${profile.id}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const loadedSubmission = profileWithSubmission.submissions.find((entry) => entry.id === repeatableSubmission.id);
  const existingAsset = loadedSubmission?.data?.assets?.[0];
  if (!existingAsset?.accountName) throw new Error('Could not load existing repeatable item');

  const editedAsset = { accountName: `${existingAsset.accountName}-edited`, value: Number(existingAsset.value) + 1 };
  const editResponse = await jsonFetch(`/api/forms/submissions/${repeatableSubmission.id}/repeatable-items/assets/0`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ item: editedAsset })
  });
  if (editResponse.item.accountName !== editedAsset.accountName) throw new Error('Repeatable item edit failed');

  const invalidEdit = await fetch(`http://127.0.0.1:${port}/api/forms/submissions/${repeatableSubmission.id}/repeatable-items/assets/0`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ item: { accountName: 'Invalid number', value: 'not-a-number' } })
  });
  if (invalidEdit.status !== 400) throw new Error('Repeatable item validation did not reject bad numeric value');

  const updatedProfileDetail = await jsonFetch(`/api/profiles/${profile.id}`, { headers: { Authorization: `Bearer ${login.token}` } });
  const updatedSubmission = updatedProfileDetail.submissions.find((entry) => entry.id === repeatableSubmission.id);
  if (updatedSubmission.data.assets[0].accountName !== editedAsset.accountName) throw new Error('Profile detail did not reflect edited repeatable item');

  const allSubmissions = await jsonFetch('/api/forms/submissions', { headers: { Authorization: `Bearer ${login.token}` } });
  const persistedSubmission = allSubmissions.find((entry) => entry.id === repeatableSubmission.id);
  if (persistedSubmission.data.assets[0].value !== editedAsset.value) throw new Error('Submission list did not persist edited repeatable item');

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

  console.log(JSON.stringify({
    login: login.user.email,
    profileId: profile.id,
    editedSubmissionId: repeatableSubmission.id,
    noteId: note.id,
    inviteRole: readonlySession.user.role,
    draftCount: drafts.length,
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
