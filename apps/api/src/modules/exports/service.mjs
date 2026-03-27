import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'

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
      readyNow: Number(queue.readyNow || 0),
      stalled: Number(queue.stalled || 0),
      total: Number(queue.total || pending + running + completed + failed + deadLetter)
    }
  }
}

export function createExportsService({ exportsRepository, policy, store }) {
  return {
    list(user, options = {}) {
      policy.requireGuard(user, 'canReadExports')
      return exportsRepository.list(createFirmContext(user), options)
    },
    create(user, input) {
      policy.requireGuard(user, 'canWriteExports')
      return runAuditedMutation(store, () => exportsRepository.create(createFirmContext(user), input))
    },
    processQueuedExports(user) {
      policy.requireGuard(user, 'canProcessExports')
      return exportsRepository.processQueued()
    },
    retry(user, exportId) {
      policy.requireGuard(user, 'canWriteExports')
      return runAuditedMutation(store, () => exportsRepository.retry(createFirmContext(user), exportId))
    },
    getQueueHealth(user) {
      policy.requireGuard(user, 'canReadExports')
      return normalizeQueueHealthPayload(exportsRepository.getQueueHealth(createFirmContext(user)))
    },
    retryFailed(user, options = {}) {
      policy.requireGuard(user, 'canWriteExports')
      return exportsRepository.retryFailed(createFirmContext(user), options)
    },
    getDownload(user, exportId) {
      policy.requireGuard(user, 'canReadExports')
      return exportsRepository.getDownload(createFirmContext(user), exportId)
    }
  }
}
