export function createAuditService({ store }) {
  return {
    list(user) { return store.listAudit(user); }
  };
}
