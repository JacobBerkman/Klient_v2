import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.env.CI_SMOKE_PORT || 3011);
const baseUrl = `http://${host}:${port}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetDb() {
  rmSync('data/app.db', { force: true });
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Failed to parse JSON from ${path}: ${text.slice(0, 160)}`);
  }
  return { response, data };
}

function startServer() {
  const server = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      LOG_LEVEL: process.env.LOG_LEVEL || 'warn'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return server;
}

async function waitForReady() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const { response, data } = await jsonFetch('/ready');
      if (response.ok) return data;
    } catch {
      // server still starting
    }
    await wait(150);
  }
  throw new Error('Server did not become ready in time.');
}

async function stopServer(server) {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    server.once('exit', () => resolve());
    setTimeout(resolve, 1500);
  });
}

async function expectHttp(path, options, expectedStatus, label) {
  const { response, data } = await jsonFetch(path, options);
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected ${expectedStatus}, got ${response.status} with body ${JSON.stringify(data)}`);
  }
  return data;
}

async function verifyDeterministicSeed() {
  resetDb();
  const first = startServer();
  const firstReady = await waitForReady();
  await stopServer(first);

  resetDb();
  const second = startServer();
  const secondReady = await waitForReady();
  await stopServer(second);

  if (JSON.stringify(firstReady.querySummary) !== JSON.stringify(secondReady.querySummary)) {
    throw new Error(`Seed query summary is not deterministic. first=${JSON.stringify(firstReady.querySummary)} second=${JSON.stringify(secondReady.querySummary)}`);
  }

  return firstReady.querySummary;
}

async function runRegressionSuite() {
  resetDb();
  const server = startServer();

  try {
    await waitForReady();

    await expectHttp('/api/profiles', {}, 401, 'unauthenticated profile list should fail');

    const invalidJsonResponse = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"broken"'
    });
    if (invalidJsonResponse.status !== 400) {
      const text = await invalidJsonResponse.text();
      throw new Error(`invalid JSON validation: expected 400, got ${invalidJsonResponse.status} body=${text}`);
    }

    await expectHttp('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'incorrect' })
    }, 400, 'invalid credentials should fail');

    const adminA = await expectHttp('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
    }, 200, 'seed admin login');

    const authA = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminA.token}` };

    const inviteReadonly = await expectHttp('/api/invites', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ email: 'readonly+ci@demo.test', role: 'readonly' })
    }, 201, 'create readonly invite');

    const readonlySession = await expectHttp('/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteReadonly.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' })
    }, 200, 'accept readonly invite');

    await expectHttp('/api/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readonlySession.token}` },
      body: JSON.stringify({ clientId: 'x', templateId: 'x', type: 'pdf' })
    }, 401, 'readonly role export write should be blocked');

    const firmB = await expectHttp('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firmName: 'Isolation Wealth B', firstName: 'Firm', lastName: 'Two', email: 'admin2@demo.test', password: 'ChangeMe123!' })
    }, 201, 'register second firm');

    const authB = { 'Content-Type': 'application/json', Authorization: `Bearer ${firmB.token}` };

    const profileB = await expectHttp('/api/profiles', {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({ kind: 'prospect', firstName: 'Tenant', lastName: 'OnlyB', email: 'tenantb@example.com', stage: 'discovery' })
    }, 201, 'create profile for firm B');

    const profileA = await expectHttp('/api/profiles', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ kind: 'prospect', firstName: 'Tenant', lastName: 'OnlyA', email: 'tenanta@example.com', stage: 'analysis' })
    }, 201, 'create profile for firm A');

    const searchA = await expectHttp('/api/profiles?search=OnlyB', {
      headers: { Authorization: `Bearer ${adminA.token}` }
    }, 200, 'firm A cannot see firm B profile');
    if (searchA.some((entry) => entry.id === profileB.id)) throw new Error('Tenancy regression: firm A can view firm B profile.');

    const searchB = await expectHttp('/api/profiles?search=OnlyA', {
      headers: { Authorization: `Bearer ${firmB.token}` }
    }, 200, 'firm B cannot see firm A profile');
    if (searchB.some((entry) => entry.id === profileA.id)) throw new Error('Tenancy regression: firm B can view firm A profile.');

    const templateA = await expectHttp('/api/templates/auto-build', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ name: 'CI Export Template', fields: ['client.name', 'client.email'] })
    }, 201, 'create export template');

    const exportJob = await expectHttp('/api/exports', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ clientId: profileA.id, templateId: templateA.id, type: 'pdf' })
    }, 201, 'create export job');

    const processed = await expectHttp('/api/exports/process', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminA.token}` }
    }, 200, 'process queued exports');
    if (processed.processed < 1) throw new Error('Expected queued exports to be processed.');

    const exportsA = await expectHttp('/api/exports', {
      headers: { Authorization: `Bearer ${adminA.token}` }
    }, 200, 'list exports after processing');

    const completedJob = exportsA.find((job) => job.id === exportJob.id);
    if (!completedJob || completedJob.status !== 'completed' || !completedJob.output?.fileName) {
      throw new Error(`Export generation regression: job did not complete. ${JSON.stringify(completedJob)}`);
    }

    const auditA = await expectHttp('/api/audit', {
      headers: { Authorization: `Bearer ${adminA.token}` }
    }, 200, 'audit list for firm A');
    const auditB = await expectHttp('/api/audit', {
      headers: { Authorization: `Bearer ${firmB.token}` }
    }, 200, 'audit list for firm B');
    if (auditA.some((event) => event.firmId === firmB.user.firmId) || auditB.some((event) => event.firmId === adminA.user.firmId)) {
      throw new Error('Audit tenancy regression: cross-firm events leaked.');
    }

    const ready = await expectHttp('/ready', {}, 200, 'ready endpoint summary');

    return {
      adminFirm: adminA.user.firmId,
      secondFirm: firmB.user.firmId,
      exportId: exportJob.id,
      readySummary: ready.querySummary,
      readonlyRole: readonlySession.user.role
    };
  } finally {
    await stopServer(server);
  }
}

async function run() {
  const seedSummary = await verifyDeterministicSeed();
  const regression = await runRegressionSuite();

  console.log(JSON.stringify({
    deterministicSeedSummary: seedSummary,
    regression
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
