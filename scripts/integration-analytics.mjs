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

  const draft = await context.request('/api/forms/submissions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: prospect.id, templateId: 'analytics-template', status: 'draft', data: { a: 1 } })
  });

  const lock = await context.request(`/api/forms/drafts/${draft.id}/lock`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ leaseMs: 30_000 })
  });

  const revised = await context.request(`/api/forms/drafts/${draft.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ leaseId: lock.lock.leaseId, expectedRevisionId: lock.revisionId, data: { a: 2 } })
  });

  const conflict = await context.requestExpectError(`/api/forms/drafts/${draft.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ leaseId: lock.lock.leaseId, expectedRevisionId: 1, data: { a: 3 } })
  }, 409);

  const invite = await context.request('/api/invites', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: `advisor.${Date.now()}@example.com`, role: 'advisor' })
  });
  await context.request('/api/invites/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invite.token, firstName: 'Ari', lastName: 'Advisor', password: 'StrongPass123A' })
  });
  const advisorSession = await context.login(invite.email, 'StrongPass123A');
  const advisorConflict = await context.requestExpectError(`/api/forms/drafts/${draft.id}/lock`, {
    method: 'POST',
    headers: context.authHeaders(advisorSession.token),
    body: JSON.stringify({ leaseMs: 30_000 })
  }, 409);

  const analytics = await context.request('/api/analytics', { headers: { Authorization: `Bearer ${admin.token}` } });
  const audit = await context.request('/api/audit', { headers: { Authorization: `Bearer ${admin.token}` } });

  assert(typeof analytics.stageCounts === 'object' && analytics.stageCounts !== null, 'Analytics stage counts missing');
  assert(Array.isArray(analytics.summary?.funnel), 'Funnel metrics missing');
  assert(typeof analytics.summary?.stageAging === 'object' && analytics.summary.stageAging !== null, 'Stage aging metrics missing');
  assert(Array.isArray(analytics.summary?.formCompletionRates), 'Form completion rates missing');
  assert(Array.isArray(analytics.summary?.advisorProductivity), 'Advisor productivity metrics missing');
  assert(analytics.materialized?.firmId, 'Materialized analytics summary missing');
  assert((analytics.stageCounts.proposal || 0) >= 1, 'Updated stage count missing');
  assert(revised.ok === true && revised.submission.revisionId > 1, 'Draft revision did not increment');
  assert(conflict.conflict === true && conflict.mergePrompt?.type === 'revision_conflict', 'Expected draft revision conflict');
  assert(advisorConflict.conflict === true, 'Expected lock conflict for second advisor');
  assert(audit.some((event) => event.action === 'pipeline.stage_changed'), 'Audit trail missing stage transition');

  console.log(JSON.stringify({
    suite: 'integration-analytics',
    proposalCount: analytics.stageCounts.proposal || 0,
    draftRevision: revised.submission.revisionId,
    conflictType: conflict.mergePrompt?.type,
    auditEvents: audit.length
  }, null, 2));
} finally {
  await context.shutdown();
}
