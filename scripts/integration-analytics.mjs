import { assert, createTestContext } from './test-harness.mjs';

const context = await createTestContext('analytics');

try {
  const admin = await context.login();
  const headers = context.authHeaders(admin.token);

  const prospect = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'prospect', firstName: 'Analytics', lastName: 'Prospect', email: `analytics.prospect+${Date.now()}@example.com`, stage: 'discovery' })
  });

  await context.request(`/api/profiles/${prospect.id}/stage`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ stage: 'proposal' })
  });

  const analytics = await context.request('/api/analytics', { headers: { Authorization: `Bearer ${admin.token}` } });
  const audit = await context.request('/api/audit', { headers: { Authorization: `Bearer ${admin.token}` } });

  assert(typeof analytics.stageCounts === 'object' && analytics.stageCounts !== null, 'Analytics stage counts missing');
  assert((analytics.stageCounts.proposal || 0) >= 1, 'Updated stage count missing');
  assert(audit.some((event) => event.action === 'pipeline.stage_changed'), 'Audit trail missing stage transition');

  console.log(JSON.stringify({ suite: 'integration-analytics', proposalCount: analytics.stageCounts.proposal || 0, auditEvents: audit.length }, null, 2));
} finally {
  await context.shutdown();
}
