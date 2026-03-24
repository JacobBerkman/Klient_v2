export function createAuditService({ store, policy }) {
  return {
    list(user) { policy.requireGuard(user, 'canReadAudit'); return store.listAudit(user); }
  };
}
