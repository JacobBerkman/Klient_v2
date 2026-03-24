import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpServer } from '../server.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('GET /api/dashboard routes through policy + profiles service', async () => {
  const calls = [];
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' };
  const modules = {
    auth: { requireUser: () => (calls.push('auth.requireUser'), fakeUser) },
    policy: { requireGuard: (user, guard) => calls.push(`policy:${user.id}:${guard}`) },
    profiles: { getDashboard: (user) => (calls.push(`profiles.getDashboard:${user.id}`), { ok: true }) }
  };
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) });
  const address = await listen(server);
  const res = await fetch(`http://${address.address}:${address.port}/api/dashboard`, { headers: { authorization: 'Bearer token' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(calls, ['auth.requireUser', 'policy:u1:canViewDashboard', 'profiles.getDashboard:u1']);
  await close(server);
});

test('GET /api/profiles forwards query params to profiles service', async () => {
  const calls = [];
  const fakeUser = { id: 'u1', firmId: 'f1', role: 'admin' };
  const modules = {
    auth: { requireUser: () => fakeUser },
    policy: { requireGuard: () => calls.push('policy') },
    profiles: {
      listProfiles: (_user, query) => {
        calls.push(query);
        return [{ id: 'p1' }];
      }
    }
  };
  const server = createHttpServer({ modules: new Proxy(modules, { get: (target, prop) => target[prop] || {} }) });
  const address = await listen(server);
  const res = await fetch(`http://${address.address}:${address.port}/api/profiles?kind=prospect&search=casey`, { headers: { authorization: 'Bearer token' } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.length, 1);
  assert.deepEqual(calls, ['policy', { kind: 'prospect', search: 'casey' }]);
  await close(server);
});
