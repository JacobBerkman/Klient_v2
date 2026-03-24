import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const port = 3010;
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const serverEntrypoint = resolve(repoRoot, 'apps/api/src/server.mjs');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still starting.
    }

    await wait(100);
  }

  throw new Error(`Timed out waiting for smoke server on port ${port}.`);
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.message || 'Request failed'}`);
  return data;
}

async function run() {
  const cwd = await mkdtemp(join(tmpdir(), 'klient-smoke-'));
  const server = spawn(process.execPath, [serverEntrypoint], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  await waitForServer();
  try {
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
      noteId: note.id,
      inviteRole: readonlySession.user.role,
      draftCount: drafts.length,
      exportStatus: exportsList.find((job) => job.id === exportJob.id)?.status,
      totalProfiles: dashboard.stats.totalProfiles,
      templateStatus: published.status
    }, null, 2));
  } catch (error) {
    error.message = `${error.message}\n${stderr}`.trim();
    throw error;
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolveExit) => server.once('exit', resolveExit));
    await rm(cwd, { recursive: true, force: true });
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
