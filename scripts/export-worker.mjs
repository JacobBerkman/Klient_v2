import { completeQueuedExports } from '../apps/api/src/storage.mjs';

const failureJobIds = (process.env.EXPORT_WORKER_FAIL_JOB_IDS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const staleAfterMs = Number(process.env.EXPORT_WORKER_STALE_AFTER_MS || 5 * 60 * 1000);

const result = completeQueuedExports({ failureJobIds, staleAfterMs });
console.log(JSON.stringify(result, null, 2));
