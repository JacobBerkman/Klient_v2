import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/passwords.mjs';

function loadStoreWithIsolatedState() {
  const previousCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-contract-'));
  process.chdir(tempDir);
  process.env.APP_SECRET = 'test-secret-for-auth-contract';
  process.env.AUTH_PROVIDER = 'local';
  const moduleUrl = pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`;
  return import(moduleUrl).then((mod) => {
    const store = mod.createStore();
    process.chdir(previousCwd);
    return store;
  });
}

test('local auth provider preserves register/login behavior', async () => {
  const store = await loadStoreWithIsolatedState();

  assert.throws(() => store.auth.register({
    firmName: 'Weak Password Wealth',
    firstName: 'Casey',
    lastName: 'Jones',
    email: 'casey@example.com',
    password: 'weakpass'
  }), /Password must/);

  const registration = store.auth.register({
    firmName: 'Secure Wealth',
    firstName: 'Alex',
    lastName: 'Stone',
    email: 'alex@example.com',
    password: 'SecurePass123!'
  });

  assert.equal(store.requireUser(registration.token).email, 'alex@example.com');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => store.auth.login({ email: 'alex@example.com', password: 'invalid' }), /Invalid email or password/);
  }
  assert.throws(() => store.auth.login({ email: 'alex@example.com', password: 'invalid' }), /Too many failed login attempts/);
});

test('local auth provider preserves password reset behavior', async () => {
  const store = await loadStoreWithIsolatedState();

  store.auth.register({
    firmName: 'Reset Partners',
    firstName: 'Jordan',
    lastName: 'Reed',
    email: 'jordan@example.com',
    password: 'AnotherSecure123!'
  });

  const reset = store.auth.requestReset({ email: 'jordan@example.com' });
  assert.ok(reset.token);

  assert.throws(() => store.auth.resetPassword({ token: reset.token, password: 'weak' }), /Password must/);

  const result = store.auth.resetPassword({ token: reset.token, password: 'ResetSecure123!' });
  assert.deepEqual(result, { ok: true });

  const login = store.auth.login({ email: 'jordan@example.com', password: 'ResetSecure123!' });
  assert.equal(store.requireUser(login.token).email, 'jordan@example.com');
});

test('legacy store auth methods remain backward-compatible aliases', async () => {
  const store = await loadStoreWithIsolatedState();

  const registration = store.register({
    firmName: 'Alias Advisory',
    firstName: 'Morgan',
    lastName: 'Bates',
    email: 'morgan@example.com',
    password: 'AliasSecure123!'
  });

  assert.ok(registration.token);
  const reset = store.requestPasswordReset('morgan@example.com');
  assert.ok(reset.token);

  assert.deepEqual(store.resetPassword({ token: reset.token, password: 'AliasReset123!' }), { ok: true });
  const session = store.login({ email: 'morgan@example.com', password: 'AliasReset123!' });
  assert.equal(store.requireUser(session.token).email, 'morgan@example.com');
});


test('local auth provider upgrades legacy SHA-256 password hashes on login', async () => {
  const store = await loadStoreWithIsolatedState();

  const legacyPassword = 'LegacySecure123!';
  const legacyHash = createHash('sha256').update(legacyPassword).digest('hex');
  const user = store.state.users.find((entry) => entry.email === 'admin@demo.test');
  user.passwordHash = legacyHash;

  const session = store.auth.login({ email: 'admin@demo.test', password: legacyPassword });
  assert.ok(session.token);

  const upgraded = store.state.users.find((entry) => entry.id === user.id).passwordHash;
  assert.notEqual(upgraded, legacyHash);
  assert.match(upgraded, /^scrypt_v1\$/);
  assert.equal(store.requireUser(session.token).email, 'admin@demo.test');
});

test('local auth provider stores new registrations with scrypt hashes', async () => {
  const store = await loadStoreWithIsolatedState();

  store.auth.register({
    firmName: 'Hash Forward LLC',
    firstName: 'Taylor',
    lastName: 'Nguyen',
    email: 'taylor@example.com',
    password: 'ModernHash123!'
  });

  const user = store.state.users.find((entry) => entry.email === 'taylor@example.com');
  assert.match(user.passwordHash, /^scrypt_v1\$/);
  assert.notEqual(user.passwordHash, createHash('sha256').update('ModernHash123!').digest('hex'));
  assert.notEqual(user.passwordHash, hashPassword('ModernHash123!'));
});
