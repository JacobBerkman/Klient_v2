import { completeQueuedExports, readExportWorkerStatus, readStorageHealth } from '../apps/api/src/storage.mjs';

const before = readExportWorkerStatus();
const result = completeQueuedExports();
const after = readExportWorkerStatus();
console.log(JSON.stringify({
  processed: result.processed,
  statusBefore: before,
  statusAfter: after,
  storageHealth: readStorageHealth()
}, null, 2));
