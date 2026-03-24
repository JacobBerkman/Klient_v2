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
    const error = new Error(data.message || 'Request failed');
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

async function expectFailure(action, expectedText) {
  try {
    await action();
  } catch (error) {
    if (!String(error.message).includes(expectedText)) {
      throw new Error(`Expected failure containing "${expectedText}" but received "${error.message}"`);
    }
    return;
  }
  throw new Error(`Expected request to fail with "${expectedText}"`);
}

async function run() {
  await wait(700);
  await jsonFetch('/ready');

  const session = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };

  const created = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Flow', lastName: 'Tester', email: 'flow.tester@example.com', stage: 'analysis' })
  });

  const updated = await jsonFetch(`/api/profiles/${created.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({
      phone: '555-123-9012',
      dateOfBirth: '1990-09-30',
      address: { line1: '10 Main St', city: 'Dallas', state: 'TX', postalCode: '75201' },
      source: { cityOrLocation: 'Dallas', venue: 'Workshop', occurredOn: '2026-03-24' },
      customProfile: { preferredLanguage: 'en', householdRiskBand: 'moderate' }
    })
  });

  if (updated.phone !== '555-123-9012') throw new Error('Profile contact update failed.');
  if (updated.dateOfBirth !== '1990-09-30') throw new Error('DOB update failed.');
  if (updated.source?.displayValue !== 'Dallas X Workshop X 2026-03-24') throw new Error('Source normalization failed.');
  if (updated.customProfile?.householdRiskBand !== 'moderate') throw new Error('customProfile update failed.');

  await expectFailure(() => jsonFetch(`/api/profiles/${created.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ source: { cityOrLocation: 'Dallas' } })
  }), 'source requires cityOrLocation, venue, and occurredOn');

  await expectFailure(() => jsonFetch(`/api/profiles/${created.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ dateOfBirth: '09/30/1990' })
  }), 'YYYY-MM-DD');

  const convertedClient = await jsonFetch(`/api/profiles/${created.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', stage: 'analysis' })
  });
  if (convertedClient.kind !== 'client') throw new Error('Prospect to client conversion failed.');
  if (convertedClient.stage !== null || convertedClient.stageOrderIndex !== null) throw new Error('Stage clearing on client conversion failed.');

  const convertedProspect = await jsonFetch(`/api/profiles/${created.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'prospect' })
  });
  if (convertedProspect.kind !== 'prospect') throw new Error('Client to prospect conversion failed.');
  if (convertedProspect.stage !== 'discovery') throw new Error('Prospect stage initialization failed.');
  if (!Number.isFinite(convertedProspect.stageOrderIndex) || convertedProspect.stageOrderIndex < 1) throw new Error('Prospect stage order initialization failed.');

  const stageHistory = await jsonFetch(`/api/profiles/${created.id}/stage-history`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!stageHistory.find((entry) => entry.toStage === null)) throw new Error('Conversion to client stage history not tracked.');
  if (!stageHistory.find((entry) => entry.toStage === 'discovery')) throw new Error('Conversion to prospect stage history not tracked.');
}

run()
  .finally(() => {
    server.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
