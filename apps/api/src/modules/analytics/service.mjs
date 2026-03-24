export function createAnalyticsService({ store, reads }) {
  return {
    get(user) {
      return { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) };
    },
    getDiagnosticsContext(user) {
      const auditEvents = store.listAudit(user);
      const exports = store.listExports(user);
      return { auditEvents, exports };
    }
  };
}
