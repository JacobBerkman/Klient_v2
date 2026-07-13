// Marketing-events service. Thin policy-guarded wrapper over the store (same
// shape as the pipeline service). Events are guarded at canWriteProfiles-level:
// they are prospect source-attribution data, the closest existing guard, and
// share the [admin, advisor] write / [admin, advisor, readonly] read role set
// with profile management. The store re-checks the equivalent permission
// (profiles:read/write) as defense in depth.
export function createEventsService({ store, policy }) {
  return {
    listEvents(user, { includeArchived = false, limit } = {}) {
      policy.requireGuard(user, 'canReadProfiles')
      return store.listEvents(user, { includeArchived, limit })
    },
    createEvent(user, input) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.createEvent(user, input)
    },
    updateEvent(user, eventId, patch) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.updateEvent(user, eventId, patch)
    },
    archiveEvent(user, eventId) {
      policy.requireGuard(user, 'canWriteProfiles')
      return store.archiveEvent(user, eventId)
    }
  }
}
