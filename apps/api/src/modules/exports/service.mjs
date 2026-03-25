export function createExportsService({ store, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadExports')
      return store.listExports(user)
    },
    create(user, input) {
      policy.requireGuard(user, 'canWriteExports')
      return store.createExport(user, input)
    },
    processQueuedExports(user) {
      policy.requireGuard(user, 'canProcessExports')
      return store.processQueuedExports()
    },
    retry(user, exportId) {
      policy.requireGuard(user, 'canWriteExports')
      return store.retryExport(user, exportId)
    },
    getQueueHealth(user) {
      policy.requireGuard(user, 'canReadExports')
      return store.getExportQueueHealth(user)
    },
    retryFailed(user, options) {
      policy.requireGuard(user, 'canWriteExports')
      return store.retryFailedExports(user, options)
    }
  }
}
