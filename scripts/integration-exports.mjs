import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('exports');

try {
  const admin = await context.login();
  const headers = context.authHeaders(admin.token);

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'client', firstName: 'Export', lastName: 'Client', email: `export.client+${Date.now()}@example.com` })
  });
  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Export Template', fields: ['client.name', 'client.email'] })
  });
  await context.request(`/api/templates/${template.id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } });

  const job = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  });

  const processOne = await context.request('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } });
  const retry = await context.request(`/api/exports/${job.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } });
  const processTwo = await context.request('/api/exports/process', { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } });
  const exportsList = await context.request('/api/exports', { headers: { Authorization: `Bearer ${admin.token}` } });

  assert(processOne.processed >= 1, 'Expected queued export processing');
  assert(retry.status === 'queued', 'Retry should requeue the job');
  assert(processTwo.processed >= 1, 'Expected retried export processing');
  assert(exportsList.some((entry) => entry.id === job.id && entry.status === 'completed'), 'Export job was not completed');

  console.log(JSON.stringify({ suite: 'integration-exports', exportId: job.id, finalStatus: 'completed' }, null, 2));
} finally {
  await context.shutdown();
}
