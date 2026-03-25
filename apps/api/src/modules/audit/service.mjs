import { createFirmContext } from '../shared/tenancy.mjs'

export function createAuditService({ store, policy }) {
  return {
    list(user) {
      policy.requireGuard(user, 'canReadAudit')
      return store.listAudit(createFirmContext(user))
    }
  }
}
