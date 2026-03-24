import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalyticsSummary } from '../analytics.mjs';

function fixture() {
  const nowIso = '2026-03-24T00:00:00.000Z';
  const users = [
    { id: 'u1', firstName: 'Ada', lastName: 'Advisor', role: 'advisor' },
    { id: 'u2', firstName: 'Rae', lastName: 'Readonly', role: 'readonly' }
  ];

  const prospects = [
    { id: 'p1', stage: 'discovery', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'p2', stage: 'analysis', createdAt: '2026-03-02T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' },
    { id: 'p3', stage: 'completed', createdAt: '2026-03-03T00:00:00.000Z', updatedAt: '2026-03-03T00:00:00.000Z' },
    { id: 'p4', stage: 'drop_nurture', createdAt: '2026-03-04T00:00:00.000Z', updatedAt: '2026-03-04T00:00:00.000Z' }
  ];

  const stageChanges = [
    { clientId: 'p1', toStage: 'discovery', changedAt: '2026-03-10T00:00:00.000Z' },
    { clientId: 'p2', toStage: 'analysis', changedAt: '2026-03-05T00:00:00.000Z' },
    { clientId: 'p3', toStage: 'completed', changedAt: '2026-03-20T00:00:00.000Z' }
  ];

  const formSubmissions = [
    { templateId: 't1', status: 'draft' },
    { templateId: 't1', status: 'submitted' },
    { templateId: 't2', status: 'submitted' }
  ];

  const exportJobs = [
    { type: 'pdf', status: 'completed' },
    { type: 'csv', status: 'queued' },
    { type: 'pdf', status: 'completed' }
  ];

  const auditEvents = [
    { actorUserId: 'u1', action: 'profile.created', occurredAt: '2026-03-20T00:00:00.000Z' },
    { actorUserId: 'u1', action: 'export_job.retried', occurredAt: '2026-03-22T00:00:00.000Z' },
    { actorUserId: 'u2', action: 'invite.created', occurredAt: '2026-02-01T00:00:00.000Z' }
  ];

  return {
    nowIso,
    prospects,
    profiles: [...prospects, { id: 'c1', kind: 'client' }],
    households: [{ id: 'h1' }],
    documentTemplates: [{ id: 'dt1' }],
    formSubmissions,
    exportJobs,
    stageChanges,
    auditEvents,
    users
  };
}

test('buildAnalyticsSummary computes funnel, aging, bottlenecks, forms, exports, and advisor activity', () => {
  const analytics = buildAnalyticsSummary(fixture());

  assert.equal(analytics.profileCount, 5);
  assert.equal(analytics.funnel.entered, 4);
  assert.equal(analytics.funnel.completed, 1);
  assert.equal(analytics.funnel.dropped, 1);
  assert.equal(analytics.funnel.completionRatePct, 25);

  const analysisAging = analytics.stageAging.perStage.find((entry) => entry.stage === 'analysis');
  assert.equal(analysisAging.averageAgeDays, 19);
  assert.equal(analytics.bottlenecks.count, 2);
  assert.equal(analytics.bottlenecks.stages[0].severity, 'high');

  assert.equal(analytics.formCompletion.completionRatePct, 66.7);
  assert.equal(analytics.formCompletion.byTemplate.find((entry) => entry.templateId === 't1').completionRatePct, 50);

  assert.equal(analytics.exportUsage.totalExports, 3);
  assert.equal(analytics.exportUsage.completionRatePct, 66.7);
  assert.equal(analytics.exportUsage.retryCount, 1);
  assert.equal(analytics.exportUsage.byType.pdf, 2);

  assert.equal(analytics.advisorActivity.totalActiveAdvisors, 2);
  assert.equal(analytics.advisorActivity.advisors[0].userId, 'u1');
  assert.equal(analytics.advisorActivity.advisors[0].last30DaysEvents, 2);
});


test('buildAnalyticsSummary handles empty datasets', () => {
  const analytics = buildAnalyticsSummary({
    prospects: [],
    profiles: [],
    households: [],
    documentTemplates: [],
    formSubmissions: [],
    exportJobs: [],
    stageChanges: [],
    auditEvents: [],
    users: [],
    nowIso: '2026-03-24T00:00:00.000Z'
  });

  assert.equal(analytics.funnel.completionRatePct, 0);
  assert.equal(analytics.stageAging.overallAverageAgeDays, 0);
  assert.equal(analytics.bottlenecks.count, 0);
  assert.equal(analytics.formCompletion.completionRatePct, 0);
  assert.equal(analytics.exportUsage.completionRatePct, 0);
  assert.equal(analytics.advisorActivity.totalActiveAdvisors, 0);
});
