import { decodeCursor, encodeCursor } from '../shared/cursor.mjs'
import { authCategoryPrefixes } from '../activity/categories.mjs'
import { CANONICAL_AUDIT_FIELDS, createCanonicalAuditEvent } from './schema.mjs'

// /api/activity hides other users' auth-category events from advisors and
// read-only users, but the raw audit endpoint handed those same roles every
// event with full before/after payloads -- so the privacy rule could be
// sidestepped simply by reading /api/audit instead. Same rule, same SQL
// enforcement, one definition of "auth category".
function authPrivacyFor(user) {
  return {
    restrictAuthToSelf: user.role !== 'admin',
    authPrefixes: authCategoryPrefixes(),
    selfUserId: user.id
  }
}

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
    list(user, filters = {}) {
      policy.requireGuard(user, 'canReadAudit')
      // The store clamps the read to the newest 200 events (default and max).
      return store.listAudit(user, { limit: filters.limit, ...authPrivacyFor(user) }).map(normalizeLegacyEvent)
    },
    // Opt-in keyset pagination ({ items, nextCursor }) so the audit UI can walk
    // past the newest 200 events — a hard requirement for compliance review.
    // The no-cursor response above is unchanged.
    listPage(user, filters = {}) {
      policy.requireGuard(user, 'canReadAudit')
      const requestedLimit = Number.parseInt(filters.limit, 10)
      // The keyset reader returns { events, nextCursor }; the HTTP envelope
      // uses the { items, nextCursor } shape every other paged list exposes.
      const { events, nextCursor } = store.listAuditPage(user, {
        cursor: decodeCursor(filters.cursor),
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 200,
        ...authPrivacyFor(user)
      })
      return { items: (events || []).map(normalizeLegacyEvent), nextCursor: encodeCursor(nextCursor) }
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
