import { spawn } from 'node:child_process';

const port = 3020;
const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  return { response, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  await wait(700);

  const contract = await fetchJson('/api/contract');
  assert(contract.response.ok, 'Expected /api/contract to return 200');
  assert(contract.data.version === 'v1', 'Expected contract version to be v1');
  assert(Array.isArray(contract.data.basePaths) && contract.data.basePaths.includes('/api/v1'), 'Expected /api/v1 in basePaths');

  const missingAuthLegacy = await fetchJson('/api/profiles');
  assert(missingAuthLegacy.response.status === 401, 'Expected legacy auth-protected endpoint to return 401');
  assert(missingAuthLegacy.data.error?.code === 'AUTH_REQUIRED', 'Expected AUTH_REQUIRED error code for legacy endpoint');

  const missingAuthVersioned = await fetchJson('/api/v1/profiles');
  assert(missingAuthVersioned.response.status === 401, 'Expected versioned auth-protected endpoint to return 401');
  assert(missingAuthVersioned.data.error?.status === 401, 'Expected error.status for versioned endpoint');
  assert(missingAuthVersioned.data.meta?.apiVersion === 'v1', 'Expected versioned metadata for errors');

  const login = await fetchJson('/api/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });

  assert(login.response.status === 200, 'Expected /api/v1/login to return 200');
  assert(typeof login.data.data?.token === 'string', 'Expected versioned login token at data.token');

  const profiles = await fetchJson('/api/v1/profiles', {
    headers: { Authorization: `Bearer ${login.data.data.token}` }
  });

  assert(profiles.response.status === 200, 'Expected /api/v1/profiles to return 200');
  assert(Array.isArray(profiles.data.data), 'Expected versioned list response envelope');
  assert(profiles.data.meta?.requestId, 'Expected versioned meta.requestId');
}

run()
  .finally(() => {
    server.kill('SIGTERM');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
