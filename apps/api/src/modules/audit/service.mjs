import { CANONICAL_AUDIT_FIELDS, createCanonicalAuditEvent } from './schema.mjs'

function normalizeLegacyEvent(event = {}) {
  if (event.actor && Object.prototype.hasOwnProperty.call(event, 'timestamp')) {
    return createCanonicalAuditEvent(event)
  }
  return createCanonicalAuditEvent({
    id: event.id,
    actor: { userId: event.actorUserId || null },
    firmId: event.firmId,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    after: event.metadata || null,
    timestamp: event.occurredAt
  })
}

export function createAuditService({ store, policy }) {
  return {
    schema: CANONICAL_AUDIT_FIELDS,
    list(user) {
      policy.requireGuard(user, 'canReadAudit')
      return store.listAudit(user).map(normalizeLegacyEvent)
    }
  }
}

export { CANONICAL_AUDIT_FIELDS, createCanonicalAuditEvent }

export function runAuditedMutation(store, mutation) {
  const before = Array.isArray(store?.state?.auditEvents) ? store.state.auditEvents.length : null
  const result = mutation()
  if (result && typeof result.then === 'function') {
    return result.then((resolved) => {
      if (before !== null && Array.isArray(store?.state?.auditEvents) && store.state.auditEvents.length <= before) {
        throw new Error('Mutating service method executed without recording an audit event.')
      }
      return resolved
    })
  }
  if (before !== null && Array.isArray(store?.state?.auditEvents) && store.state.auditEvents.length <= before) {
    throw new Error('Mutating service method executed without recording an audit event.')
  }
  return result
}
