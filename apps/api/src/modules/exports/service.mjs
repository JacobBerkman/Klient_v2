import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'

export function createExportsService({ exportsRepository, policy, store }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadExports')
      return exportsRepository.list(createFirmContext(user))
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
      return exportsRepository.getQueueHealth(createFirmContext(user))
    },
    retryFailed(user, options = {}) {
      policy.requireGuard(user, 'canWriteExports')
      return exportsRepository.retryFailed(createFirmContext(user), options)
    }
  }
}
