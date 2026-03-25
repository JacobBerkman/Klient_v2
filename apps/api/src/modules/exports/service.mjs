import { runAuditedMutation } from '../audit/service.mjs'

export function createExportsService({ store, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadExports')
      return store.listExports(user)
    },
    create(user, input) {
      policy.requireGuard(user, 'canWriteExports')
      return runAuditedMutation(store, () => store.createExport(user, input))
    },
    processQueuedExports(user) {
      policy.requireGuard(user, 'canProcessExports')
      return store.processQueuedExports()
    },
    retry(user, exportId) {
      policy.requireGuard(user, 'canWriteExports')
      return runAuditedMutation(store, () => store.retryExport(user, exportId))
    }
  }
}
