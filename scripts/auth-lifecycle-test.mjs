import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function jsonFetch(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || 'Request failed');
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

async function expectFailure(run, expectedMessage) {
  await assert.rejects(run, (error) => error.message.includes(expectedMessage));
}

const serverPath = resolve('apps/api/src/server.mjs');

async function withServer(testFn) {
  const port = String(3300 + Math.floor(Math.random() * 200));
  const cwd = await mkdtemp(join(tmpdir(), 'klient-auth-test-'));
  const server = spawn(process.execPath, [serverPath], {
    cwd,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await wait(750);
    await jsonFetch(port, '/ready');
    await testFn(Number(port), cwd);
  } finally {
    server.kill('SIGTERM');
    await wait(200);
    await rm(cwd, { recursive: true, force: true });
  }
}

await withServer(async (port, cwd) => {
  const adminLogin = await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.test', password: 'ChangeMe123!' })
  });

  await expectFailure(
    () => jsonFetch(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@demo.test', password: 'WrongPassword123!' })
    }),
    'Invalid email or password.'
  );

  const adminAuth = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminLogin.token}` };

  const invite = await jsonFetch(port, '/api/invites', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ email: 'advisor1@example.test', role: 'advisor' })
  });

  const accepted = await jsonFetch(port, '/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Ava', lastName: 'Advisor', password: 'Advisor123!' })
  });
  assert.equal(accepted.user.email, 'advisor1@example.test');

  const expiringInvite = await jsonFetch(port, '/api/invites', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({ email: 'expired@example.test', role: 'readonly', expiresInMs: 1 })
  });

  const adminDetail = await jsonFetch(port, '/api/profiles', { headers: { Authorization: `Bearer ${adminLogin.token}` } });
  assert.ok(Array.isArray(adminDetail));

  const reset = await jsonFetch(port, '/api/password-resets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'advisor1@example.test' })
  });

  await jsonFetch(port, '/api/password-resets/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: reset.token, password: 'Advisor456!' })
  });

  const sessionA = await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'advisor1@example.test', password: 'Advisor456!' })
  });
  await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'advisor1@example.test', password: 'Advisor456!' })
  });

  const users = await jsonFetch(port, '/api/users', { headers: { Authorization: `Bearer ${adminLogin.token}` } });
  const advisor = users.find((entry) => entry.email === 'advisor1@example.test');
  assert.ok(advisor, 'Advisor user should exist');

  const revokeResult = await jsonFetch(port, `/api/users/${advisor.id}/sessions/revoke`, {
    method: 'POST',
    headers: adminAuth
  });
  assert.ok(revokeResult.revokedSessionCount >= 2);

  await expectFailure(
    () => jsonFetch(port, '/api/session', { headers: { Authorization: `Bearer ${sessionA.token}` } }),
    'Authentication required.'
  );

  const sessionC = await jsonFetch(port, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'advisor1@example.test', password: 'Advisor456!' })
  });

  await jsonFetch(port, '/api/logout-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionC.token}` }
  });

  await expectFailure(
    () => jsonFetch(port, '/api/session', { headers: { Authorization: `Bearer ${sessionC.token}` } }),
    'Authentication required.'
  );

  const resetToExpire = await jsonFetch(port, '/api/password-resets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'advisor1@example.test', expiresInMs: 1 })
  });
  await wait(20);

  await expectFailure(
    () => jsonFetch(port, '/api/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiringInvite.token, firstName: 'Expired', lastName: 'Invite', password: 'Password123!' })
    }),
    'Invite expired.'
  );

  await expectFailure(
    () => jsonFetch(port, '/api/password-resets/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToExpire.token, password: 'Reset123!' })
    }),
    'Reset token expired.'
  );

  const audit = await jsonFetch(port, '/api/audit', { headers: { Authorization: `Bearer ${adminLogin.token}` } });
  const actions = new Set(audit.map((entry) => entry.action));
  assert.ok(actions.has('auth.login.succeeded'));
  assert.ok(actions.has('auth.login.failed'));
  assert.ok(actions.has('auth.password_reset.completed'));
  assert.ok(actions.has('invite.accepted'));
  assert.ok(actions.has('auth.session.revoked'));
});

console.log('Auth lifecycle checks passed.');
