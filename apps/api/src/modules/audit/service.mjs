export function createAuditService({ auditRepository }) {
  return {
    list(user) { return auditRepository.list(user); }
  };
}
