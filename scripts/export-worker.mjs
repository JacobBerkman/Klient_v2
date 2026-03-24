import { randomUUID } from 'node:crypto';
import { closeDatabase, processExportQueueTick, readExportWorkerStatus, readStorageHealth } from '../apps/api/src/storage.mjs';

const workerId = process.env.EXPORT_WORKER_ID || `export-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const pollMs = Number(process.env.EXPORT_WORKER_POLL_MS || 500);
const leaseMs = Number(process.env.EXPORT_WORKER_LEASE_MS || 15_000);
const batchSize = Number(process.env.EXPORT_WORKER_BATCH_SIZE || 5);
const runOnce = process.env.EXPORT_WORKER_ONCE === '1';
const crashAfterLease = process.env.EXPORT_WORKER_CRASH_AFTER_LEASE === '1';

function processJob(job) {
  const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0);
  if (failCount > 0) {
    throw new Error(`Simulated export failure for ${job.id}`);
  }
  return {
    fileName: `${job.type}-${Date.now()}.json`,
    preview: { clientId: job.clientId, templateId: job.templateId },
    idempotencyKey: job.execution?.idempotencyKey || job.idempotencyKey || job.id,
    execution: job.execution || null,
    workerId,
    processedAt: new Date().toISOString()
  };
}

function runTick() {
  let crashed = false;
  return processExportQueueTick({
    workerId,
    limit: batchSize,
    leaseMs,
    onLeased(leased) {
      if (crashAfterLease && !crashed && leased.length > 0) {
        crashed = true;
        console.error(JSON.stringify({ message: 'export-worker.crash_after_lease', workerId, leased: leased.length }));
        process.exit(92);
      }
    },
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

console.log(JSON.stringify({ message: 'export-worker.started', workerId, pollMs, leaseMs, batchSize, crashAfterLease }));

while (!stopping) {
  const result = runTick();
  const queue = readExportWorkerStatus();
  const diagnostics = {
    message: 'export-worker.tick',
    workerId,
    metrics: result,
    queueHealth: {
      queued: queue.queued,
      processing: queue.processing,
      completed: queue.completed,
      deadLetter: queue.deadLetter,
      readyNow: queue.readyNow,
      stalled: queue.stalled,
      activeLeases: queue.activeLeases
    }
  };
  if (result.leased > 0 || result.failed > 0 || queue.stalled > 0) {
    console.log(JSON.stringify(diagnostics));
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
