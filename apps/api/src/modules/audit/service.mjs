export function createAuditService({ store, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadAudit')
      return store.listAudit(user)
    },
    recordSensitiveRead(user, payload) {
      policy.requireGuard(user, 'canReadAudit')
      return store.addAuditEvent?.(user, {
        entityType: 'profile',
        action: 'sensitive.read',
        ...payload
      })
    },
    recordSensitiveWrite(user, payload) {
      policy.requireGuard(user, 'canReadAudit')
      return store.addAuditEvent?.(user, {
        entityType: 'profile',
        action: 'sensitive.write',
        ...payload
      })
    }
  }
}
