import { randomUUID } from 'node:crypto';
import { closeDatabase, processExportQueueTick, readExportWorkerStatus, readStorageHealth } from '../apps/api/src/storage.mjs';

const workerId = process.env.EXPORT_WORKER_ID || `export-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Number(process.env.EXPORT_WORKER_POLL_MS || 500);
const leaseMs = Number(process.env.EXPORT_WORKER_LEASE_MS || 15_000);
const batchSize = Number(process.env.EXPORT_WORKER_BATCH_SIZE || 5);
const runOnce = process.env.EXPORT_WORKER_ONCE === '1';

function processJob(job) {
  const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0);
  if (failCount > 0) {
    throw new Error(`Simulated export failure for ${job.id}`);
  }
  return {
    fileName: `${job.type}-${Date.now()}.json`,
    preview: { clientId: job.clientId, templateId: job.templateId },
    workerId,
    processedAt: new Date().toISOString()
  };
}

function runTick() {
  return processExportQueueTick({
    workerId,
    limit: batchSize,
    leaseMs,
    processor: processJob
  });
}

if (runOnce) {
  const before = readExportWorkerStatus();
  const result = runTick();
  const after = readExportWorkerStatus();
  console.log(JSON.stringify({ mode: 'once', workerId, result, statusBefore: before, statusAfter: after, storageHealth: readStorageHealth() }, null, 2));
  closeDatabase();
  process.exit(0);
}

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ message: 'export-worker.shutdown', signal, workerId }));
  closeDatabase();
  process.exit(0);
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log(JSON.stringify({ message: 'export-worker.started', workerId, pollMs, leaseMs, batchSize }));

while (!stopping) {
  const result = runTick();
  if (result.leased > 0 || result.failed > 0) {
    console.log(JSON.stringify({ message: 'export-worker.tick', workerId, ...result }));
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
