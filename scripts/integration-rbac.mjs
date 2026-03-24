import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('rbac');

try {
  const admin = await context.login();
  const adminHeaders = context.authHeaders(admin.token);

  const invite = await context.request('/api/invites', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: `readonly+${Date.now()}@test.local`, role: 'readonly' })
  });

  const readonly = await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Read', lastName: 'Only', password: 'Readonly123!' })
  });

  await context.request('/api/profiles', { headers: { Authorization: `Bearer ${readonly.token}` } });
  const blockedProfileWrite = await context.requestExpectError('/api/profiles', {
    method: 'POST',
    headers: context.authHeaders(readonly.token),
    body: JSON.stringify({ kind: 'prospect', firstName: 'Blocked', lastName: 'User', email: 'blocked@example.com' })
  }, 401);
  const blockedTemplatePublish = await context.requestExpectError('/api/templates/0000/publish', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readonly.token}` }
  }, 401);

  assert(/Missing permission/.test(blockedProfileWrite.message), 'Readonly should not create profiles');
  assert(/Missing permission/.test(blockedTemplatePublish.message), 'Readonly should not publish templates');

  console.log(JSON.stringify({ suite: 'integration-rbac', readonlyUserId: readonly.user.id, role: readonly.user.role }, null, 2));
} finally {
  await context.shutdown();
}
