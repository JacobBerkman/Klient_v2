export function createAuditService({ auditRepository }) {
  return {
    list(user) { return auditRepository.list(user); }
export function createAuditService({ store, policy }) {
  return {
    list(user) { policy.requireGuard(user, 'canReadAudit'); return store.listAudit(user); }
  };
}
