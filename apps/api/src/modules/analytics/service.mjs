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
    }
  };
}
