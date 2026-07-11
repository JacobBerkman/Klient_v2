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

// Guard-count source: the real store exposes countAuditEvents() backed by the
// audit_events table (the append-only source of truth); test doubles may
// still carry an in-memory state.auditEvents array. The count must be a
// finite number to be trusted (proxy-based test doubles can fabricate a
// countAuditEvents member that returns junk). Returns null when the store
// offers neither, which disables the guard.
function readAuditCount(store) {
  if (typeof store?.countAuditEvents === 'function') {
    const count = store.countAuditEvents()
    if (Number.isFinite(count)) return count
  }
  return Array.isArray(store?.state?.auditEvents) ? store.state.auditEvents.length : null
}

export function runAuditedMutation(store, mutation) {
  const before = readAuditCount(store)
  const result = mutation()
  if (result && typeof result.then === 'function') {
    return result.then((resolved) => {
      const after = readAuditCount(store)
      if (before !== null && after !== null && after <= before) {
        throw new Error('Mutating service method executed without recording an audit event.')
      }
      return resolved
    })
  }
  const after = readAuditCount(store)
  if (before !== null && after !== null && after <= before) {
    throw new Error('Mutating service method executed without recording an audit event.')
  }
  return result
}
