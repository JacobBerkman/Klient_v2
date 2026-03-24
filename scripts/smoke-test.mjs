import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('smoke');

try {
  const health = await context.request('/health');
  const ready = await context.request('/ready');
  const login = await context.login();

  const headers = context.authHeaders(login.token);
  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Smoke',
      lastName: 'Path',
      email: `smoke.path+${Date.now()}@example.com`,
      stage: 'discovery'
    })
  });

  const dashboard = await context.request('/api/dashboard', { headers: { Authorization: `Bearer ${login.token}` } });

  assert(health.status === 'ok', 'Health check failed');
  assert(ready.status === 'ready', 'Readiness check failed');
  assert(Boolean(ready.querySummary), 'Readiness query summary missing');
  assert(Boolean(profile.id), 'Profile creation failed');
  assert(dashboard.stats.totalProfiles >= 1, 'Dashboard stats did not populate');

  console.log(JSON.stringify({
    suite: 'smoke',
    user: login.user.email,
    profileId: profile.id,
    totalProfiles: dashboard.stats.totalProfiles
  }, null, 2));
} finally {
  await context.shutdown();
}
