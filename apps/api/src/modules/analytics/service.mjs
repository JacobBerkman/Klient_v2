export function createAnalyticsService({ analyticsRepository }) {
  return {
    get(user) {
      return {
        stageCounts: analyticsRepository.getStageCounts(user.firmId),
        summary: analyticsRepository.getSummary(user)
      };
    },
    getDiagnosticsContext(user) {
      return {
        auditEvents: analyticsRepository.listAuditEvents(user),
        exports: analyticsRepository.listExports(user)
      };
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
