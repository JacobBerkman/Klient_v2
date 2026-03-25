export class AnalyticsRepository {
  constructor({ store, reads }) {
    this.store = store
    this.reads = reads
  }
  getStageCounts(firmId) {
    return this.reads.getAnalytics(firmId)
  }
  getSummary(user, filters = {}) {
    return this.store.getAnalytics(user, filters)
  }
  getDashboard(user, filters = {}) {
    return this.store.getAnalyticsDashboard(user, filters)
  }
  exportCsv(user, filters = {}) {
    return this.store.exportAnalyticsCsv(user, filters)
  }
  listAuditEvents(user) {
    return this.store.listAudit(user)
  }
  listExports(user) {
    return this.store.listExports(user)
  }
}
