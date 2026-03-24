import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('templates');

try {
  const admin = await context.login();
  const headers = context.authHeaders(admin.token);

  const template = await context.request('/api/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Estate Intake',
      fileName: 'estate-intake.pdf',
      blueprint: { sections: [{ title: 'Client', fields: ['client.name'] }] },
      mappings: [{ key: 'client.name', source: 'profile.fullName' }]
    })
  });

  const mapped = await context.request(`/api/templates/${template.id}/mappings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mappings: [{ key: 'client.address.city', source: 'profile.address.city' }] })
  });

  const published = await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` }
  });

  const templates = await context.request('/api/templates', { headers: { Authorization: `Bearer ${admin.token}` } });

  assert(mapped.mappings.length === 1, 'Template mappings update failed');
  assert(published.status === 'published', 'Template publish failed');
  assert(templates.some((entry) => entry.id === template.id && entry.status === 'published'), 'Published template missing from list');

  console.log(JSON.stringify({ suite: 'integration-templates', templateId: template.id, status: published.status }, null, 2));
} finally {
  await context.shutdown();
}
