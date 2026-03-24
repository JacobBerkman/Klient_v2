const ACTIVE_EXPORT_STATUSES = new Set(['queued', 'processing', 'retried']);

function nowIso(value) {
  return value || new Date().toISOString();
}

function toEpoch(value) {
  return value ? new Date(value).getTime() : 0;
}

export function initializeExportJob({ id, firmId, clientId, templateId, type = 'pdf', idempotencyKey = null, createdAt = nowIso() }) {
  return {
    id,
    firmId,
    clientId,
    templateId,
    type,
    idempotencyKey,
    status: 'queued',
    output: null,
    retryCount: 0,
    attemptCount: 0,
    maxRetries: 3,
    lastError: null,
    processingStartedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt,
    updatedAt: createdAt
  };
}

export function ensureExportJobShape(job) {
  if (typeof job.retryCount !== 'number') job.retryCount = 0;
  if (typeof job.attemptCount !== 'number') job.attemptCount = 0;
  if (typeof job.maxRetries !== 'number') job.maxRetries = 3;
  if (!Object.hasOwn(job, 'lastError')) job.lastError = null;
  if (!Object.hasOwn(job, 'processingStartedAt')) job.processingStartedAt = null;
  if (!Object.hasOwn(job, 'completedAt')) job.completedAt = null;
  if (!Object.hasOwn(job, 'failedAt')) job.failedAt = null;
  if (!Object.hasOwn(job, 'idempotencyKey')) job.idempotencyKey = null;
}

export function findIdempotentExportJob(exportJobs, { firmId, idempotencyKey }) {
  if (!idempotencyKey) return null;
  return exportJobs.find((job) => job.firmId === firmId && job.idempotencyKey === idempotencyKey && ACTIVE_EXPORT_STATUSES.has(job.status)) || null;
}

export function markExportForRetry(job, { currentTime } = {}) {
  ensureExportJobShape(job);
  if (job.retryCount >= job.maxRetries) throw new Error('Retry limit reached for export job.');
  if (!['failed', 'completed'].includes(job.status)) throw new Error('Only failed or completed exports can be retried.');
  const ts = nowIso(currentTime);
  job.status = 'retried';
  job.retryCount += 1;
  job.output = null;
  job.lastError = null;
  job.failedAt = null;
  job.processingStartedAt = null;
  job.updatedAt = ts;
  return job;
}

export function processExportJobs(exportJobs, { currentTime, staleAfterMs = 5 * 60 * 1000, failureJobIds = [] } = {}) {
  const ts = nowIso(currentTime);
  const failureIds = new Set(failureJobIds);
  let processed = 0;
  let failed = 0;
  let recovered = 0;
  let retried = 0;

  for (const job of exportJobs) {
    ensureExportJobShape(job);

    if (job.status === 'processing' && toEpoch(job.processingStartedAt) && (new Date(ts).getTime() - toEpoch(job.processingStartedAt)) >= staleAfterMs) {
      job.status = 'queued';
      job.processingStartedAt = null;
      job.updatedAt = ts;
      recovered += 1;
    }

    if (!['queued', 'retried'].includes(job.status)) continue;
    if (job.status === 'retried') retried += 1;

    job.status = 'processing';
    job.processingStartedAt = ts;
    job.attemptCount += 1;
    job.updatedAt = ts;

    try {
      if (failureIds.has(job.id)) throw new Error('Export worker simulated failure.');
      job.status = 'completed';
      job.completedAt = ts;
      job.lastError = null;
      job.output = { fileName: `${job.type}-${Date.now()}.json`, preview: { clientId: job.clientId, templateId: job.templateId }, attemptCount: job.attemptCount };
      job.updatedAt = ts;
      processed += 1;
    } catch (error) {
      job.status = 'failed';
      job.failedAt = ts;
      job.lastError = error.message || 'Export failed.';
      job.updatedAt = ts;
      failed += 1;
    }
  }

  return { processed, failed, recovered, retried };
}
