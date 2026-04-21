import { randomUUID } from 'node:crypto'
import {
  closeDatabase,
  processExportQueueTickAsync,
  readExportWorkerStatus,
  readStorageHealth
} from '../apps/api/src/storage.mjs'
import { renderExportArtifact } from '../apps/api/src/export-artifact.mjs'
import { objectStorage } from '../apps/api/src/object-storage/index.mjs'

const workerId = process.env.EXPORT_WORKER_ID || `export-worker-${process.pid}-${randomUUID().slice(0, 8)}`
const pollMs = Number(process.env.EXPORT_WORKER_POLL_MS || 500)
const leaseMs = Number(process.env.EXPORT_WORKER_LEASE_MS || 15_000)
const batchSize = Number(process.env.EXPORT_WORKER_BATCH_SIZE || 5)
const runOnce = process.env.EXPORT_WORKER_ONCE === '1'
const crashAfterLease = process.env.EXPORT_WORKER_CRASH_AFTER_LEASE === '1'

async function processJob(job) {
  if (job.output) {
    return job.output
  }
  const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0)
  if (failCount > 0) {
    const error = new Error(`Simulated export failure for ${job.id}`)
    error.failureClass = 'transient'
    throw error
  }
  const artifact = await renderExportArtifact(job, { objectStorage })
  const key = `${job.firmId}/exports/${artifact.fileName}`
  const stored = await objectStorage.putObject({
    bucket: objectStorage.bucketExports,
    key,
    body: artifact.body,
    contentType: artifact.object.contentType,
    retentionClass: artifact.object.retentionClass,
    metadata: {
      checksum: artifact.artifact.checksum,
      exportJobId: job.id,
      renderer: artifact.artifact.renderer,
      templateId: job.templateId,
      clientId: job.clientId
    }
  })
  return {
    fileName: artifact.fileName,
    preview: artifact.preview,
    artifact: {
      ...artifact.artifact,
      checksum: stored.checksum || artifact.artifact.checksum,
      sizeBytes: artifact.body.length
    },
    object: {
      bucket: objectStorage.bucketExports,
      key,
      checksum: stored.checksum || artifact.object.checksum,
      contentType: artifact.object.contentType,
      retentionClass: artifact.object.retentionClass
    },
    idempotencyKey: job.execution?.idempotencyKey || job.idempotencyKey || job.id,
    execution: job.execution || null,
    workerId,
    processedAt: new Date().toISOString()
  }
}

async function runTick() {
  let crashed = false
  return processExportQueueTickAsync({
    workerId,
    limit: batchSize,
    leaseMs,
    onLeased(leased) {
      if (crashAfterLease && !crashed && leased.length > 0) {
        crashed = true
        console.error(JSON.stringify({ message: 'export-worker.crash_after_lease', workerId, leased: leased.length }))
        process.exit(92)
      }
    },
    processor: processJob
  })
}

function toQueueMachineState(queue = {}) {
  return {
    activeLeases: Array.isArray(queue.activeLeaseDetails) ? queue.activeLeaseDetails : [],
    retries: {
      active: Number(queue?.byStatus?.retrying || 0),
      countsByAttempt: Array.isArray(queue.retryCounts) ? queue.retryCounts : []
    },
    failed: Number(queue.failed || queue?.byStatus?.failed || 0),
    deadLetter: Number(queue.deadLetter || queue?.byStatus?.['dead-letter'] || 0),
    completed: Number(queue.completed || queue?.byStatus?.completed || 0)
  }
}

if (runOnce) {
  const before = readExportWorkerStatus()
  const result = await runTick()
  const after = readExportWorkerStatus()
  console.log(
    JSON.stringify(
      { mode: 'once', workerId, result, statusBefore: before, statusAfter: after, storageHealth: readStorageHealth() },
      null,
      2
    )
  )
  closeDatabase()
  process.exit(0)
}

let stopping = false
const stop = (signal) => {
  if (stopping) return
  stopping = true
  console.log(JSON.stringify({ message: 'export-worker.shutdown', signal, workerId }))
  closeDatabase()
  process.exit(0)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

console.log(
  JSON.stringify({
    message: 'export-worker.started',
    workerId,
    mode: 'long-running',
    pollMs,
    leaseMs,
    batchSize,
    crashAfterLease
  })
)

while (!stopping) {
  const result = await runTick()
  const queue = readExportWorkerStatus()
  const diagnostics = {
    message: 'export-worker.tick',
    workerId,
    metrics: result,
    queueHealth: {
      queued: queue.queued,
      running: queue.running,
      completed: queue.completed,
      deadLetter: queue.deadLetter,
      failed: queue.failed,
      readyNow: queue.readyNow,
      stalled: queue.stalled,
      activeLeases: queue.activeLeases,
      machineState: toQueueMachineState(queue)
    }
  }
  if (result.leased > 0 || result.failed > 0 || queue.stalled > 0) {
    console.log(JSON.stringify(diagnostics))
  }
  const nextWaitMs = result.leased > 0 ? Math.max(25, Math.floor(pollMs / 2)) : pollMs
  await new Promise((resolve) => setTimeout(resolve, nextWaitMs))
}
