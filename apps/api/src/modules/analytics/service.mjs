import { createFirmContext } from '../shared/tenancy.mjs'

export function createAnalyticsService({ store, reads, policy }) {
  return {
    get(user, filters = {}) {
      policy.requireGuard(user, 'canReadAnalytics')
      return { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user, filters) }
    },
    getDashboard(user, filters = {}) {
      policy.requireGuard(user, 'canReadAnalytics')
      return store.getAnalyticsDashboard(user, filters)
    },
    exportCsv(user, filters = {}) {
      policy.requireGuard(user, 'canReadAnalytics')
      return store.exportAnalyticsCsv(user, filters)
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
