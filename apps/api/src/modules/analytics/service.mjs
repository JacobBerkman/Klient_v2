import { createFirmContext } from '../shared/tenancy.mjs'

export function createAnalyticsService({ store, reads, policy }) {
  return {
    get(user) {
      policy.requireGuard(user, 'canReadAnalytics')
      const firmContext = createFirmContext(user)
      return { stageCounts: reads.getAnalytics(firmContext.firmId), summary: store.getAnalytics(firmContext) }
    },
    getDiagnosticsContext(user) {
      policy.requireGuard(user, 'canReadDiagnostics')
      const firmContext = createFirmContext(user)
      const auditEvents = store.listAudit(firmContext)
      const exports = store.listExports(firmContext)
      return { auditEvents, exports }
    }
  }
}
