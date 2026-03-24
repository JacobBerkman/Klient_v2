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
  if (!response.ok) throw new Error(`${path}: ${data.message || 'Request failed'}`);
  return data;
}

async function run() {
  await wait(700);
  const login = await jsonFetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

  const primary = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'Harper', lastName: 'Roley', email: 'harper-roley@example.test' })
  });
  const spouse = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'Sky', lastName: 'Roley', email: 'sky-roley@example.test' })
  });
  const dependent = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'Drew', lastName: 'Roley', email: 'drew-roley@example.test' })
  });
  const other = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'Parker', lastName: 'Other', email: 'parker-other@example.test' })
  });

  const householdA = await jsonFetch('/api/households', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Roley Household', primaryClientId: primary.id })
  });
  await jsonFetch(`/api/households/${householdA.id}/members`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: spouse.id, role: 'spouse' })
  });
  await jsonFetch(`/api/households/${householdA.id}/members`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: dependent.id, role: 'dependent' })
  });

  await jsonFetch('/api/households/link-spouse', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ primaryClientId: primary.id, spouseClientId: spouse.id })
  });
  await jsonFetch('/api/households/unlink-spouse', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: primary.id })
  });

  await jsonFetch(`/api/households/${householdA.id}/members/${dependent.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ role: 'other' })
  });
  await jsonFetch(`/api/households/${householdA.id}/reassign-primary`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ primaryClientId: spouse.id })
  });

  const householdB = await jsonFetch('/api/households', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Other Household', primaryClientId: other.id })
  });
  await jsonFetch(`/api/households/${householdA.id}/merge`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ targetHouseholdId: householdB.id })
  });

  const splitClient = await jsonFetch('/api/profiles', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ kind: 'client', firstName: 'Split', lastName: 'Target', email: 'split-target@example.test' })
  });
  await jsonFetch(`/api/households/${householdB.id}/members`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: splitClient.id, role: 'dependent' })
  });
  const splitResult = await jsonFetch(`/api/households/${householdB.id}/split`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ clientId: splitClient.id, name: 'Split Household' })
  });

  const households = await jsonFetch('/api/households', { headers: { Authorization: `Bearer ${login.token}` } });
  const audit = await jsonFetch('/api/audit', { headers: { Authorization: `Bearer ${login.token}` } });
  const merged = households.find((entry) => entry.id === householdB.id);
  const splitHousehold = households.find((entry) => entry.id === splitResult.destinationHousehold.id);

  if (!merged) throw new Error('Merged household missing');
  if (!merged.members.find((entry) => entry.clientId === spouse.id)) throw new Error('Merged household missing reassigned primary member');
  if (!merged.members.find((entry) => entry.clientId === other.id && entry.role === 'primary')) throw new Error('Merge should preserve target household primary member');
  if (!splitHousehold) throw new Error('Split destination household missing');
  if (!splitHousehold.members.find((entry) => entry.clientId === splitClient.id && entry.role === 'primary')) throw new Error('Split member did not become primary in new household');

  const requiredActions = [
    'household.member_role_changed',
    'household.primary_reassigned',
    'household.spouse_unlinked',
    'household.merged',
    'household.member_split'
  ];
  for (const action of requiredActions) {
    if (!audit.find((entry) => entry.action === action)) {
      throw new Error(`Expected audit action not found: ${action}`);
    }
  }

  console.log(JSON.stringify({
    mergedHouseholdId: householdB.id,
    splitHouseholdId: splitResult.destinationHousehold.id,
    auditActionsVerified: requiredActions
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
