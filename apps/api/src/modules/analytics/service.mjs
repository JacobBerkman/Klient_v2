export function createAnalyticsService({ store, reads, policy }) {
  return {
    get(user) {
      policy.requireGuard(user, 'canReadAnalytics');
      return { stageCounts: reads.getAnalytics(user.firmId), summary: store.getAnalytics(user) };
    },
    getDiagnosticsContext(user) {
      policy.requireGuard(user, 'canReadDiagnostics');
      const auditEvents = store.listAudit(user);
      const exports = store.listExports(user);
      return { auditEvents, exports };
    }
  };
}
