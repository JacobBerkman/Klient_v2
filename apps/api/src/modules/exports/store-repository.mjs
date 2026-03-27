import { randomUUID } from 'node:crypto'
import {
  enqueueExportJob,
  listExportQueueJobs,
  processExportQueueTick,
  readExportWorkerStatus,
  requeueExportJob
} from '../../storage.mjs'
import { buildExportArtifact, buildExportArtifactPayload } from '../../export-artifact.mjs'
import { resolveExportData, computeMappingVersionHash } from '../../export-data-resolution.mjs'
import { createFirmContext, validateEntityOwnership } from '../shared/tenancy.mjs'

function latestTemplateVersion(template) {
  const latest = Array.isArray(template?.versions) && template.versions.length > 0 ? template.versions[template.versions.length - 1] : null
  return latest?.versionHash || template?.versionHash || latest?.version || null
}

function resolveSubmission(state, firmId, submissionId, clientId) {
  if (submissionId) {
    return state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === firmId) || null
  }
  const candidates = state.formSubmissions
    .filter((entry) => entry.firmId === firmId && (!clientId || entry.profileId === clientId))
    .sort((a, b) => String(b.submittedAt || b.createdAt || '').localeCompare(String(a.submittedAt || a.createdAt || '')) ||
      String(b.id).localeCompare(String(a.id)))
  return candidates[0] || null
}

function createRenderContext({ firm, template, client, submission }) {
  const mappings = template?.mappings || []
  const resolved = resolveExportData({ mappings, profile: client, submission })
  return {
    template: {
      id: template?.id || null,
      name: template?.name || null,
      version: latestTemplateVersion(template),
      versionHash: latestTemplateVersion(template),
      mappingVersionHash: resolved.mappingVersionHash || computeMappingVersionHash(mappings),
      mappings
    },
    firm: firm
      ? {
          id: firm.id,
          name: firm.name || null,
          slug: firm.slug || null,
          branding: firm.branding || null
        }
      : null,
    client: client ? {
      id: client.id,
      firstName: client.firstName || null,
      lastName: client.lastName || null,
      email: client.email || null,
      phone: client.phone || null,
      dateOfBirth: client.dateOfBirth || null,
      kind: client.kind || null,
      stage: client.stage || null,
      source: client.source || null
    } : null,
    submission: submission ? {
      id: submission.id,
      profileId: submission.profileId || null,
      templateId: submission.templateId || null,
      submittedAt: submission.submittedAt || submission.createdAt || null,
      data: submission.data || {}
    } : null,
    resolved
  }
}

export function createStoreExportsRepository({ state, persist, addAuditEvent, objectStorage, now = () => new Date().toISOString() }) {
  function parseIsoDate(value) {
    if (!value) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  function sortJobs(jobs, sortKey = 'createdAt_desc') {
    const sorted = jobs.slice()
    const byDate = (entry, key) => Number(new Date(entry?.[key] || 0))
    const byAttempts = (entry) => Number(entry?.attempts || 0)
    const byStatus = (entry) => String(entry?.status || '')

    const sorters = {
      createdAt_asc: (a, b) => byDate(a, 'createdAt') - byDate(b, 'createdAt'),
      createdAt_desc: (a, b) => byDate(b, 'createdAt') - byDate(a, 'createdAt'),
      updatedAt_asc: (a, b) => byDate(a, 'updatedAt') - byDate(b, 'updatedAt'),
      updatedAt_desc: (a, b) => byDate(b, 'updatedAt') - byDate(a, 'updatedAt'),
      attempts_asc: (a, b) => byAttempts(a) - byAttempts(b),
      attempts_desc: (a, b) => byAttempts(b) - byAttempts(a),
      status_asc: (a, b) => byStatus(a).localeCompare(byStatus(b)),
      status_desc: (a, b) => byStatus(b).localeCompare(byStatus(a))
    }
    const sorter = sorters[sortKey] || sorters.createdAt_desc
    return sorted.sort((a, b) => sorter(a, b) || String(a.id).localeCompare(String(b.id)))
  }

  function withArtifactMetadata(job) {
    const artifact = job?.output?.artifact || null
    return {
      ...job,
      artifact: artifact
        ? {
            ...artifact,
            contentType: job?.output?.object?.contentType || null,
            fileName: job?.output?.fileName || null,
            key: job?.output?.object?.key || null
          }
        : null,
      artifactAvailable: Boolean(job?.status === 'completed' && artifact)
    }
  }

  return {
    list(user, options = {}) {
      state.exportJobs = listExportQueueJobs()
      const status = String(options.status || '').trim().toLowerCase()
      const profileId = String(options.profileId || options.clientId || '').trim()
      const fromDate = parseIsoDate(options.fromDate)
      const toDate = parseIsoDate(options.toDate)
      const sort = String(options.sort || 'createdAt_desc').trim()

      const filtered = state.exportJobs
        .filter((entry) => entry.firmId === user.firmId)
        .filter((entry) => !status || String(entry.status || '').toLowerCase() === status)
        .filter((entry) => !profileId || entry.clientId === profileId)
        .filter((entry) => !fromDate || Number(new Date(entry.createdAt || 0)) >= fromDate.getTime())
        .filter((entry) => !toDate || Number(new Date(entry.createdAt || 0)) <= toDate.getTime())

      return sortJobs(filtered, sort).map(withArtifactMetadata)
    },
    create(user, input = {}) {
      const template = state.templateAggregates.find(
        (entry) => entry.id === input.templateId && entry.firmId === user.firmId && entry.kind !== 'form'
      )
      if (!template) throw new Error('Template not found.')

      const firm = state.firms.find((entry) => entry.id === user.firmId) || null
      const client = state.profiles.find((entry) => entry.id === input.clientId && entry.firmId === user.firmId) || null
      const submission = resolveSubmission(state, user.firmId, String(input.submissionId || '').trim(), input.clientId)
      const renderContext = createRenderContext({ firm, template, client, submission })

      const queued = enqueueExportJob({
        id: randomUUID(),
        firmId: user.firmId,
        clientId: input.clientId,
        submissionId: submission?.id || null,
        templateId: input.templateId,
        createdByUserId: user.id,
        renderContext,
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
          const artifact = buildExportArtifact(job)
          const key = `${job.firmId}/exports/${artifact.fileName}`
          return {
            ...artifact,
            idempotencyKey: job.execution?.idempotencyKey || job.idempotencyKey || job.id,
            execution: job.execution || null,
            object: {
              bucket: objectStorage.bucketExports,
              key,
              checksum: artifact.object.checksum,
              contentType: artifact.object.contentType,
              retentionClass: artifact.object.retentionClass
            }
          }
        }
      })
      return { processed: result.processed, leased: result.leased, failed: result.failed }
    },
    getDownload(user, exportId) {
      const firmContext = createFirmContext(user, { method: 'exports.download' })
      const job = validateEntityOwnership(firmContext, state.exportJobs.find((entry) => entry.id === exportId), {
        entityName: 'Export'
      })
      if (job.status !== 'completed') throw new Error('Export is not completed yet.')

      const payload = buildExportArtifactPayload(job)
      return {
        body: payload.body,
        fileName: payload.fileName,
        contentType: payload.contentType,
        checksum: payload.artifact.checksum,
        sizeBytes: payload.artifact.sizeBytes
      }
    }
  }
}
