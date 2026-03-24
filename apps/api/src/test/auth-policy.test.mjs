import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadStoreWithIsolatedState() {
  const previousCwd = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-auth-policy-'));
  process.chdir(tempDir);
  process.env.APP_SECRET = 'test-secret-for-auth-policy';
  process.env.AUTH_PROVIDER = 'local';

  const stamp = `${Date.now()}-${Math.random()}`;
  const storeModule = await import(pathToFileURL(resolve(previousCwd, 'apps/api/src/store.mjs')).href + `?t=${stamp}`);
  const providerModule = await import(pathToFileURL(resolve(previousCwd, 'apps/api/src/auth/local-provider.mjs')).href + `?t=${stamp}`);
  const store = storeModule.createStore();
  process.chdir(previousCwd);
  return { store, computeTotp: providerModule.__testUtils.computeTotp };
}

test('invite lifecycle enforces role constraints, expiration, and single-use', async () => {
  const { store } = await loadStoreWithIsolatedState();
  const adminSession = store.login({ email: 'admin@demo.test', password: 'ChangeMe123!' });
  const admin = store.requireUser(adminSession.token);

  assert.throws(() => store.inviteUser(admin, { email: 'owner@example.com', role: 'admin' }), /Invalid invite role/);

  const invite = store.inviteUser(admin, { email: 'teammate@example.com', role: 'advisor' });
  assert.ok(invite.expiresAt);

  const accepted = store.acceptInvite({
    token: invite.token,
    firstName: 'Team',
    lastName: 'Mate',
    password: 'TeamMatePass123!'
  });
  assert.ok(accepted.token);
  assert.throws(() => store.acceptInvite({
    token: invite.token,
    firstName: 'Team',
    lastName: 'Mate',
    password: 'TeamMatePass123!'
  }), /Invite not found/);

  const expiredInvite = store.inviteUser(admin, { email: 'expired@example.com', role: 'readonly' });
  const stateInvite = store.state.invites.find((entry) => entry.id === expiredInvite.id);
  stateInvite.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => store.acceptInvite({
    token: expiredInvite.token,
    firstName: 'Expired',
    lastName: 'User',
    password: 'ExpiredPass123!'
  }), /Invite expired/);
});

test('password reset policy enforces TTL, one-time usage, and user/IP rate limits', async () => {
  const { store } = await loadStoreWithIsolatedState();
  store.register({
    firmName: 'Reset Policy Wealth',
    firstName: 'Rae',
    lastName: 'Smith',
    email: 'rae@example.com',
    password: 'StartSecure123!'
  });

  const firstReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' });
  const secondReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' });
  assert.throws(() => store.auth.resetPassword({ token: firstReset.token, password: 'NextSecure123!' }), /Reset token not found/);
  assert.deepEqual(store.auth.resetPassword({ token: secondReset.token, password: 'NextSecure123!' }), { ok: true });
  assert.throws(() => store.auth.resetPassword({ token: secondReset.token, password: 'AnotherSecure123!' }), /Reset token not found/);

  const expiringReset = store.auth.requestReset({ email: 'rae@example.com', ipAddress: '192.0.2.1' });
  const resetRecord = store.state.passwordResets.find((entry) => entry.token === expiringReset.token);
  resetRecord.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.throws(() => store.auth.resetPassword({ token: expiringReset.token, password: 'FinalSecure123!' }), /Reset token expired/);

  for (let i = 0; i < 4; i += 1) {
    store.auth.requestReset({ email: 'unknown@example.com', ipAddress: '198.51.100.44' });
  }
  for (let i = 0; i < 6; i += 1) {
    store.auth.requestReset({ email: `other${i}@example.com`, ipAddress: '198.51.100.44' });
  }
  assert.throws(() => store.auth.requestReset({ email: 'another@example.com', ipAddress: '198.51.100.44' }), /Too many password reset requests from this IP/);
});

test('mfa flow enforces challenge-based login, backup codes, and lockout behavior', async () => {
  const { store, computeTotp } = await loadStoreWithIsolatedState();

  store.register({
    firmName: 'MFA Wealth',
    firstName: 'Mia',
    lastName: 'Factor',
    email: 'mia@example.com',
    password: 'StrongMfaPass123!'
  });
  const session = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' });
  const user = store.requireUser(session.token);

  const enrollment = store.startTotpEnrollment(user);
  const code = computeTotp(enrollment.secret);
  const enrollmentResult = store.confirmTotpEnrollment(user, { enrollmentToken: enrollment.enrollmentToken, code });
  assert.equal(enrollmentResult.backupCodes.length, 8);

  const mfaStart = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' });
  assert.equal(mfaStart.mfaRequired, true);

  assert.throws(() => store.login({
    email: 'mia@example.com',
    password: 'StrongMfaPass123!',
    mfaChallengeToken: mfaStart.challengeToken,
    totpCode: '000000'
  }), /Invalid MFA verification code/);

  const completed = store.login({
    email: 'mia@example.com',
    password: 'StrongMfaPass123!',
    mfaChallengeToken: mfaStart.challengeToken,
    totpCode: computeTotp(enrollment.secret)
  });
  assert.ok(completed.token);

  const nextChallenge = store.login({ email: 'mia@example.com', password: 'StrongMfaPass123!' });
  const backupLogin = store.login({
    email: 'mia@example.com',
    password: 'StrongMfaPass123!',
    mfaChallengeToken: nextChallenge.challengeToken,
    backupCode: enrollmentResult.backupCodes[0]
  });
  assert.ok(backupLogin.token);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => store.login({ email: 'mia@example.com', password: 'bad-password' }), /Invalid email or password/);
  }
  assert.throws(() => store.login({ email: 'mia@example.com', password: 'bad-password' }), /Too many failed login attempts/);
});
