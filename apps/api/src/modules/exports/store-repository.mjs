import { randomUUID } from 'node:crypto'
import {
  enqueueExportJob,
  listExportQueueJobs,
  processExportQueueTickAsync,
  readExportWorkerStatus,
  requeueExportJob
} from '../../storage.mjs'
import { renderExportArtifact, renderExportArtifactPayload } from '../../export-artifact.mjs'
import { resolveExportData, computeMappingVersionHash } from '../../export-data-resolution.mjs'
import { createFirmContext, validateEntityOwnership } from '../shared/tenancy.mjs'

function latestTemplateVersion(template) {
  const latest =
    Array.isArray(template?.versions) && template.versions.length > 0
      ? template.versions[template.versions.length - 1]
      : null
  return latest?.versionHash || template?.versionHash || latest?.version || null
}

function resolveSubmission(state, firmId, submissionId, clientId) {
  if (submissionId) {
    return state.formSubmissions.find((entry) => entry.id === submissionId && entry.firmId === firmId) || null
  }
  const candidates = state.formSubmissions
    .filter(
      (entry) => entry.firmId === firmId && (!clientId || entry.clientId === clientId || entry.profileId === clientId)
    )
    .sort(
      (a, b) =>
        String(b.submittedAt || b.createdAt || '').localeCompare(String(a.submittedAt || a.createdAt || '')) ||
        String(b.id).localeCompare(String(a.id))
    )
  return candidates[0] || null
}

function createRenderContext({ firm, template, client, submission }) {
  const mappings = template?.mappings || []
  const resolved = resolveExportData({ mappings, profile: client, submission })
  const mappingVersionHash = resolved.mappingVersionHash || computeMappingVersionHash(mappings)
  return {
    template: {
      id: template?.id || null,
      name: template?.name || null,
      version: latestTemplateVersion(template),
      versionHash: latestTemplateVersion(template),
      mappingVersionHash,
      mappings,
      sourceArtifact: template?.sourceArtifact || template?.documentMetadata?.sourceArtifact || null,
      exportReadiness: template?.exportReadiness || null,
      linkedFormTemplateId: template?.linkedFormTemplateId || null
    },
    firm: firm
      ? {
          id: firm.id,
          name: firm.name || null,
          slug: firm.slug || null,
          branding: firm.branding || null
        }
      : null,
    client: client
      ? {
          id: client.id,
          firstName: client.firstName || null,
          lastName: client.lastName || null,
          email: client.email || null,
          phone: client.phone || null,
          dateOfBirth: client.dateOfBirth || null,
          kind: client.kind || null,
          stage: client.stage || null,
          source: client.source || null
        }
      : null,
    submission: submission
      ? {
          id: submission.id,
          profileId: submission.clientId || submission.profileId || null,
          clientId: submission.clientId || submission.profileId || null,
          templateId: submission.templateId || null,
          submittedAt: submission.submittedAt || submission.createdAt || null,
          data: submission.data || {}
        }
      : null,
    resolved: {
      ...resolved,
      mappingVersionHash
    }
  }
}

function deriveStatusSemantics(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'running') return { statusCategory: 'processing', statusLabel: 'Processing' }
  if (normalized === 'retrying') return { statusCategory: 'queued', statusLabel: 'Retry Scheduled' }
  if (normalized === 'dead-letter') return { statusCategory: 'dead-letter', statusLabel: 'Dead Letter' }
  return {
    statusCategory: normalized || 'queued',
    statusLabel: normalized ? normalized.replace('-', ' ').replace(/\b\w/g, (token) => token.toUpperCase()) : 'Queued'
  }
}

function normalizeQueueSemantics(queue = {}) {
  const byStatus = queue.byStatus || {}
  const queued = Number(byStatus.queued || 0)
  const retrying = Number(byStatus.retrying || 0)
  const running = Number(byStatus.running || 0)
  const completed = Number(byStatus.completed || 0)
  const failed = Number(byStatus.failed || 0)
  const deadLetter = Number(byStatus['dead-letter'] || queue.deadLetter || 0)
  return {
    queuedOnly: queued,
    retrying,
    pending: queued + retrying,
    processing: running,
    running,
    completed,
    failed,
    deadLetter,
    readyNow: Number(queue.readyNow || 0),
    stalled: Number(queue.stalled || 0),
    total: Number(queue.total || queued + retrying + running + completed + failed + deadLetter)
  }
}

function summarizeQueueMachineState(jobs = [], generatedAt) {
  const running = jobs.filter((entry) => entry.status === 'running')
  const retrying = jobs.filter((entry) => entry.status === 'retrying')
  const failed = jobs.filter((entry) => entry.status === 'failed')
  const deadLetter = jobs.filter((entry) => entry.status === 'dead-letter')
  const completed = jobs.filter((entry) => entry.status === 'completed')

  const activeLeaseDetails = running
    .filter((entry) => entry.leaseExpiresAt)
    .map((entry) => ({
      id: entry.id,
      leasedBy: entry.leasedBy || null,
      leaseExpiresAt: entry.leaseExpiresAt || null,
      leaseExpired: Number(new Date(entry.leaseExpiresAt || 0)) <= Number(new Date(generatedAt))
    }))
    .sort((a, b) => String(a.leaseExpiresAt || '').localeCompare(String(b.leaseExpiresAt || '')))

  const retryReadyNow = retrying.filter(
    (entry) => !entry.nextAttemptAt || Number(new Date(entry.nextAttemptAt)) <= Number(new Date(generatedAt))
  )
  const retryScheduledLater = retrying.filter(
    (entry) => entry.nextAttemptAt && Number(new Date(entry.nextAttemptAt)) > Number(new Date(generatedAt))
  )
  const retryCountsByAttempt = retrying.reduce((acc, entry) => {
    const attempt = Number(entry.attempts || 0)
    acc[attempt] = (acc[attempt] || 0) + 1
    return acc
  }, {})

  const recentIds = (items) => items.slice(0, 25).map((entry) => entry.id)
  return {
    activeLeaseDetails,
    retries: {
      active: retrying.length,
      readyNow: retryReadyNow.length,
      scheduledLater: retryScheduledLater.length,
      countsByAttempt: Object.entries(retryCountsByAttempt).map(([attempt, count]) => ({
        attempt: Number(attempt),
        count
      }))
    },
    failed: {
      count: failed.length,
      ids: recentIds(failed)
    },
    deadLetter: {
      count: deadLetter.length,
      ids: recentIds(deadLetter)
    },
    completed: {
      count: completed.length,
      ids: recentIds(completed)
    }
  }
}

export function createStoreExportsRepository({
  state,
  persist,
  addAuditEvent,
  objectStorage,
  now = () => new Date().toISOString()
}) {
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
    const statusSemantics = deriveStatusSemantics(job?.status)
    const artifactReady = Boolean(job?.status === 'completed' && artifact && job?.output?.object?.key)
    return {
      ...job,
      ...statusSemantics,
      artifact: artifact
        ? {
            ...artifact,
            contentType: job?.output?.object?.contentType || null,
            fileName: job?.output?.fileName || null,
            key: job?.output?.object?.key || null
          }
        : null,
      artifactAvailable: artifactReady,
      artifactReady
    }
  }

  return {
    list(user, options = {}) {
      state.exportJobs = listExportQueueJobs()
      const status = String(options.status || '')
        .trim()
        .toLowerCase()
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
      const existing = validateEntityOwnership(
        firmContext,
        state.exportJobs.find((entry) => entry.id === exportId),
        {
          entityName: 'Export'
        }
      )

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
      const jobs = listExportQueueJobs()
      const generatedAt = now()
      const machineState = summarizeQueueMachineState(jobs, generatedAt)
      return {
        generatedAt,
        queue: {
          ...queue,
          ...normalizeQueueSemantics(queue),
          activeLeasesCount: machineState.activeLeaseDetails.length,
          activeLeaseDetails: machineState.activeLeaseDetails,
          retries: machineState.retries,
          machineState: {
            activeLeases: machineState.activeLeaseDetails,
            retries: machineState.retries,
            failed: machineState.failed,
            deadLetter: machineState.deadLetter,
            completed: machineState.completed
          }
        }
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
      const before = readExportWorkerStatus()
      const result = await processExportQueueTickAsync({
        workerId: 'api-process-endpoint',
        limit: 10,
        leaseMs: 15_000,
        async processor(job) {
          const failCount = Number(job?.metadata?.simulateFailuresRemaining || 0)
          if (failCount > 0) {
            throw new Error(`Simulated export failure for ${job.id}`)
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
            idempotencyKey: job.execution?.idempotencyKey || job.idempotencyKey || job.id,
            execution: job.execution || null,
            object: {
              bucket: objectStorage.bucketExports,
              key,
              checksum: stored.checksum || artifact.object.checksum,
              contentType: artifact.object.contentType,
              retentionClass: artifact.object.retentionClass
            }
          }
        }
      })
      const after = readExportWorkerStatus()
      const deadLettered = Math.max(0, Number(after.deadLetter || 0) - Number(before.deadLetter || 0))
      const retried = Math.max(0, Number(after.byStatus?.retrying || 0) - Number(before.byStatus?.retrying || 0))
      return { processed: result.processed, leased: result.leased, failed: result.failed, deadLettered, retried }
    },
    async getDownload(user, exportId) {
      const firmContext = createFirmContext(user, { method: 'exports.download' })
      const job = validateEntityOwnership(
        firmContext,
        state.exportJobs.find((entry) => entry.id === exportId),
        {
          entityName: 'Export'
        }
      )
      if (job.status !== 'completed') throw new Error('Export is not completed yet.')

      if (job.output?.object?.bucket && job.output?.object?.key) {
        try {
          const stored = await objectStorage.getObject(job.output.object)
          return {
            body: stored.body,
            fileName: job.output.fileName,
            contentType: stored.contentType || job.output.object.contentType,
            checksum: stored.checksum || job.output.object.checksum,
            sizeBytes: stored.body.length
          }
        } catch {
          // Older completed jobs recorded object metadata before artifact bytes were persisted.
        }
      }

      const payload = await renderExportArtifactPayload(job, { objectStorage })
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
