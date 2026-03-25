import { randomUUID } from 'node:crypto'
import {
  enqueueExportJob,
  listExportQueueJobs,
  processExportQueueTick,
  readExportWorkerStatus,
  requeueExportJob
} from '../../storage.mjs'
import { createFirmContext, validateEntityOwnership } from '../shared/tenancy.mjs'

export function createStoreExportsRepository({ state, persist, addAuditEvent, objectStorage, now = () => new Date().toISOString() }) {
  return {
    list(user) {
      state.exportJobs = listExportQueueJobs()
      return state.exportJobs.filter((entry) => entry.firmId === user.firmId)
    },
    create(user, input = {}) {
      const template = state.templateAggregates.find(
        (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')

      const queued = enqueueExportJob({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        templateId: input.templateId,
        createdByUserId: user.id,
        type: input.type || 'pdf',
        idempotencyKey: input.idempotencyKey || null,
        maxAttempts: Number(input.maxAttempts || 3),
        metadata: input.metadata || {}
      })
      addAuditEvent(user, {
        entityType: 'export_job',
        entityId: queued.id,
        action: 'export_job.created',
        metadata: {
          clientId: input.clientId,
          templateId: input.templateId,
          type: queued.type
        }
      })
      state.exportJobs = state.exportJobs.filter((entry) => entry.id !== queued.id)
      state.exportJobs.push(queued)
      persist()
      return queued
    },
    retry(user, exportId) {
      const firmContext = createFirmContext(user, { method: 'exports.retry' })
      const existing = validateEntityOwnership(firmContext, state.exportJobs.find((entry) => entry.id === exportId), {
        entityName: 'Export'
      })

      const updated = requeueExportJob(exportId)
      if (!updated) throw new Error('Export not found.')

      state.exportJobs = state.exportJobs.map((entry) => (entry.id === exportId ? updated : entry))
      addAuditEvent(user, {
        entityType: 'export_job',
        entityId: exportId,
        action: 'export_job.retry_requested',
        metadata: {
          before: { attempts: existing.attempts || 0, status: existing.status },
          after: { attempts: updated.attempts || 0, status: updated.status }
        }
      })
      persist()
      return updated
    },
    getQueueHealth() {
      const queue = readExportWorkerStatus()
      return {
        generatedAt: now(),
        queue
      }
    },
    retryFailed(user, options = {}) {
      const limit = Math.max(1, Math.min(Number(options.limit || 25), 200))
      const includeDeadLetter = options.includeDeadLetter === true
      const dryRun = options.dryRun === true
      const candidates = listExportQueueJobs()
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => entry.status === 'failed' || (includeDeadLetter && entry.status === 'dead-letter'))
        .slice(0, limit)

      if (dryRun) {
        return {
          dryRun: true,
          limit,
          includeDeadLetter,
          candidateCount: candidates.length,
          ids: candidates.map((candidate) => candidate.id)
        }
      }

      const retried = []
      for (const candidate of candidates) {
        const updated = requeueExportJob(candidate.id)
        if (updated) retried.push(updated.id)
      }

      state.exportJobs = listExportQueueJobs()
      persist()
      return { dryRun: false, limit, includeDeadLetter, retriedCount: retried.length, ids: retried }
    },
    async processQueued() {
      const result = processExportQueueTick({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0)
          if (failCount > 0) {
            job.metadata.simulateFailuresRemaining = failCount - 1
            throw new Error(`Simulated export failure for ${job.id}`)
          }
          const fileName = `${job.type}-${Date.now()}.json`
          const key = `${job.firmId}/exports/${fileName}`
          return {
            fileName,
            preview: { clientId: job.clientId, templateId: job.templateId },
            object: {
              bucket: objectStorage.bucketExports,
              key,
              checksum: null,
              contentType: 'application/json',
              retentionClass: 'export_artifact'
            }
          }
        }
      })
      return { processed: result.processed, leased: result.leased, failed: result.failed }
    }
  }
}
