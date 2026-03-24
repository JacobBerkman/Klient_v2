import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('tenancy');

try {
  const admin = await context.login();
  const adminHeaders = context.authHeaders(admin.token);

  const ownProfile = await context.request('/api/profiles', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Tenant', lastName: 'One', email: `tenant.one+${Date.now()}@example.com`, stage: 'discovery' })
  });

  const registration = await context.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firmName: 'Isolation Capital', firstName: 'Iso', lastName: 'Admin', email: `iso-admin+${Date.now()}@test.local`, password: 'Isolation123!' })
  });

  const secondHeaders = context.authHeaders(registration.token);
  const secondProfile = await context.request('/api/profiles', {
    method: 'POST',
    headers: secondHeaders,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Tenant', lastName: 'Two', email: `tenant.two+${Date.now()}@example.com`, stage: 'analysis' })
  });

  const firstFirmProfiles = await context.request('/api/profiles?search=Tenant', { headers: { Authorization: `Bearer ${admin.token}` } });
  const secondFirmProfiles = await context.request('/api/profiles?search=Tenant', { headers: { Authorization: `Bearer ${registration.token}` } });
  const firstFirmDashboard = await context.request('/api/dashboard', { headers: { Authorization: `Bearer ${admin.token}` } });
  const secondFirmDashboard = await context.request('/api/dashboard', { headers: { Authorization: `Bearer ${registration.token}` } });

  assert(firstFirmProfiles.some((profile) => profile.id === ownProfile.id), 'Primary firm cannot see its own profile');
  assert(!firstFirmProfiles.some((profile) => profile.id === secondProfile.id), 'Primary firm can see foreign profile');
  assert(secondFirmProfiles.some((profile) => profile.id === secondProfile.id), 'Secondary firm cannot see its own profile');
  assert(!secondFirmProfiles.some((profile) => profile.id === ownProfile.id), 'Secondary firm can see foreign profile');
  assert(firstFirmDashboard.firm.id !== secondFirmDashboard.firm.id, 'Dashboard firm IDs should differ across tenants');

  console.log(JSON.stringify({ suite: 'integration-tenancy', firstFirmId: firstFirmDashboard.firm.id, secondFirmId: secondFirmDashboard.firm.id }, null, 2));
} finally {
  await context.shutdown();
}
