import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'
import { log } from '../../runtime.mjs'

function normalizeFailureClass(job = {}) {
  const explicit = String(job?.failureClass || job?.failure?.classification || '').toLowerCase()
  if (explicit) return explicit
  const status = String(job?.status || '').toLowerCase()
  if (status === 'dead-letter') return 'permanent'
  if (status === 'retrying') return 'transient'
  if (status === 'failed') return 'manual'
  return null
}

function normalizeRetryState(job = {}) {
  const status = String(job?.status || '').toLowerCase()
  const deadLettered = status === 'dead-letter' || Boolean(job?.deadLetteredAt)
  const retryEligibleByStatus = !['completed', 'running'].includes(status)
  const retryEligible = Boolean(job?.retryEligible ?? retryEligibleByStatus)
  const failureClass = normalizeFailureClass(job)
  const retryClass = deadLettered ? 'dead-letter' : failureClass || (retryEligible ? 'manual' : 'blocked')
  const retryHint = retryEligible
    ? deadLettered
      ? 'Dead-letter job: verify root cause before retrying.'
      : 'Retry can be triggered now.'
    : 'Retry unavailable while job is running or completed.'

  return {
    retryEligible,
    deadLettered,
    failureClass,
    retryState: {
      eligible: retryEligible,
      class: retryClass,
      hint: retryHint
    }
  }
}

function normalizeExportJobPayload(job = {}) {
  const retryState = normalizeRetryState(job)
  const normalizedStatus = String(job?.status || '').toLowerCase()
  const hasArtifactPointer = Boolean(job?.artifact?.key || job?.output?.object?.key)
  const hasArtifactMetadata = Boolean(job?.artifact || job?.output?.artifact)
  const artifactReady = normalizedStatus === 'completed' && hasArtifactPointer && hasArtifactMetadata
  return {
    ...job,
    ...retryState,
    artifactSemantics: {
      readyRequiresCompletedStatus: true,
      hasArtifactPointer,
      hasArtifactMetadata,
      normalizedStatus
    },
    artifactAvailable: artifactReady,
    artifactReady,
    deadLetterReason: job?.failure?.reason || null,
    failureReason: job?.failure?.lastError || job?.errorMessage || null
  }
}

function normalizeQueueHealthPayload(payload = {}) {
  const queue = payload?.queue || {}
  const byStatus = queue.byStatus || {}
  const queuedOnly = Number(queue.queuedOnly ?? byStatus.queued ?? 0)
  const retrying = Number(queue.retrying ?? byStatus.retrying ?? 0)
  const running = Number(queue.running ?? byStatus.running ?? queue.processing ?? 0)
  const completed = Number(queue.completed ?? byStatus.completed ?? 0)
  const failed = Number(queue.failed ?? byStatus.failed ?? 0)
  const deadLetter = Number(queue.deadLetter ?? byStatus['dead-letter'] ?? 0)
  const pending = Number(queue.pending ?? queuedOnly + retrying)
  const activeLeases = Array.isArray(queue.activeLeaseDetails) ? queue.activeLeaseDetails : []
  const retryState = queue.retries && typeof queue.retries === 'object' ? queue.retries : {}
  const machineState = queue.machineState && typeof queue.machineState === 'object' ? queue.machineState : {}

  return {
    ...payload,
    queue: {
      ...queue,
      queuedOnly,
      retrying,
      pending,
      queued: pending,
      running,
      processing: running,
      completed,
      failed,
      deadLetter,
      failedRetryable: failed + deadLetter,
      deadLetterEligible: deadLetter,
      readyNow: Number(queue.readyNow || 0),
      stalled: Number(queue.stalled || 0),
      total: Number(queue.total || pending + running + completed + failed + deadLetter),
      activeLeases,
      activeLeasesCount: Number(queue.activeLeasesCount ?? queue.activeLeases ?? activeLeases.length),
      retries: {
        ...retryState,
        active: Number(retryState.active ?? retrying),
        readyNow: Number(retryState.readyNow ?? queue.readyNow ?? 0),
        scheduledLater: Number(retryState.scheduledLater ?? 0),
        countsByAttempt: Array.isArray(retryState.countsByAttempt) ? retryState.countsByAttempt : []
      },
      machineState: {
        ...machineState,
        activeLeases,
        retries: {
          ...retryState,
          active: Number(retryState.active ?? retrying),
          readyNow: Number(retryState.readyNow ?? queue.readyNow ?? 0),
          scheduledLater: Number(retryState.scheduledLater ?? 0),
          countsByAttempt: Array.isArray(retryState.countsByAttempt) ? retryState.countsByAttempt : []
        },
        failed: machineState.failed || { count: failed, ids: [] },
        deadLetter: machineState.deadLetter || { count: deadLetter, ids: [] },
        completed: machineState.completed || { count: completed, ids: [] }
      }
    }
  }
}

export function createExportsService({ exportsRepository, policy, store }) {
  return {
    list(user, options = {}) {
      policy.requireGuard(user, 'canReadExports')
      return exportsRepository.list(createFirmContext(user), options).map(normalizeExportJobPayload)
    },
    create(user, input) {
      policy.requireGuard(user, 'canWriteExports')
      const created = runAuditedMutation(store, () => exportsRepository.create(createFirmContext(user), input))
      log('info', 'export.lifecycle', {
        type: 'export.lifecycle',
        entity: 'export',
        id: created?.id || null,
        status: 'queued',
        firmId: user?.firmId || null,
        userId: user?.id || null
      })
      return created
    },
    async processQueuedExports(user) {
      policy.requireGuard(user, 'canProcessExports')
      const result = await exportsRepository.processQueued()
      log('info', 'export.lifecycle', {
        type: 'export.lifecycle',
        entity: 'export_batch',
        id: null,
        status: result?.failed > 0 ? 'completed_with_failures' : 'completed',
        firmId: user?.firmId || null,
        userId: user?.id || null,
        details: {
          leased: Number(result?.leased || 0),
          processed: Number(result?.processed || 0),
          failed: Number(result?.failed || 0),
          deadLettered: Number(result?.deadLettered || 0)
        }
      })
      return result
    },
    retry(user, exportId) {
      policy.requireGuard(user, 'canProcessExports')
      const result = runAuditedMutation(store, () =>
        normalizeExportJobPayload(exportsRepository.retry(createFirmContext(user), exportId))
      )
      log('info', 'export.lifecycle', {
        type: 'export.lifecycle',
        entity: 'export',
        id: exportId,
        status: 'retrying',
        firmId: user?.firmId || null,
        userId: user?.id || null
      })
      return result
    },
    getQueueHealth(user) {
      policy.requireGuard(user, 'canReadExports')
      if (user?.authMode === 'ops-token') {
        return normalizeQueueHealthPayload(exportsRepository.getQueueHealth(user))
      }
      return normalizeQueueHealthPayload(exportsRepository.getQueueHealth(createFirmContext(user)))
    },
    retryFailed(user, options = {}) {
      policy.requireGuard(user, 'canProcessExports')
      const result = exportsRepository.retryFailed(createFirmContext(user), options)
      return {
        ...result,
        retriableStatuses: result?.includeDeadLetter ? ['failed', 'dead-letter'] : ['failed'],
        deadLetterIncluded: result?.includeDeadLetter === true
      }
    },
    async getDownload(user, exportId) {
      policy.requireGuard(user, 'canReadExports')
      return exportsRepository.getDownload(createFirmContext(user), exportId)
    }
  }
}
