import test from 'node:test';
import assert from 'node:assert/strict';
import { findIdempotentExportJob, initializeExportJob, markExportForRetry, processExportJobs } from '../apps/api/src/export-jobs.mjs';

test('idempotency returns active existing job', () => {
  const createdAt = '2026-03-24T00:00:00.000Z';
  const jobs = [
    initializeExportJob({ id: 'job-1', firmId: 'firm-1', clientId: 'c1', templateId: 't1', idempotencyKey: 'abc', createdAt }),
    { ...initializeExportJob({ id: 'job-2', firmId: 'firm-1', clientId: 'c1', templateId: 't1', idempotencyKey: 'abc', createdAt }), status: 'failed' }
  ];

  const match = findIdempotentExportJob(jobs, { firmId: 'firm-1', idempotencyKey: 'abc' });
  assert.equal(match?.id, 'job-1');
});

test('processes queued jobs and captures failures', () => {
  const jobs = [
    initializeExportJob({ id: 'ok-job', firmId: 'firm-1', clientId: 'c1', templateId: 't1' }),
    initializeExportJob({ id: 'bad-job', firmId: 'firm-1', clientId: 'c2', templateId: 't2' })
  ];

  const summary = processExportJobs(jobs, { currentTime: '2026-03-24T00:00:00.000Z', failureJobIds: ['bad-job'] });

  assert.deepEqual(summary, { processed: 1, failed: 1, recovered: 0, retried: 0 });
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].attemptCount, 1);
  assert.equal(jobs[1].status, 'failed');
  assert.match(jobs[1].lastError, /simulated failure/i);
});

test('recovery and retry lifecycle', () => {
  const staleJob = initializeExportJob({ id: 'stale', firmId: 'firm-1', clientId: 'c3', templateId: 't3' });
  staleJob.status = 'processing';
  staleJob.processingStartedAt = '2026-03-24T00:00:00.000Z';

  const failedJob = initializeExportJob({ id: 'failed-1', firmId: 'firm-1', clientId: 'c4', templateId: 't4' });
  failedJob.status = 'failed';
  failedJob.lastError = 'boom';

  markExportForRetry(failedJob, { currentTime: '2026-03-24T00:10:00.000Z' });
  assert.equal(failedJob.status, 'retried');
  assert.equal(failedJob.retryCount, 1);

  const summary = processExportJobs([staleJob, failedJob], {
    currentTime: '2026-03-24T00:20:00.000Z',
    staleAfterMs: 60 * 1000,
    failureJobIds: []
  });

  assert.deepEqual(summary, { processed: 2, failed: 0, recovered: 1, retried: 1 });
  assert.equal(staleJob.status, 'completed');
  assert.equal(failedJob.status, 'completed');
});

test('retry limit blocks further retries', () => {
  const job = initializeExportJob({ id: 'retry-limit', firmId: 'firm-1', clientId: 'c4', templateId: 't4' });
  job.status = 'failed';
  job.retryCount = 3;
  job.maxRetries = 3;

  assert.throws(() => markExportForRetry(job), /Retry limit reached/);
});
