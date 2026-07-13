import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'
import { decodeCursor, encodeCursor } from '../shared/cursor.mjs'

export function createHouseholdsService({ store, policy }) {
  return {
    listHouseholds(user) {
      policy.requireGuard(user, 'canReadHouseholds')
      return store.listHouseholds(createFirmContext(user))
    },
    // Opt-in keyset pagination (limit/cursor query params); legacy bare-array
    // listHouseholds above stays untouched.
    listHouseholdsPage(user, query = {}) {
      policy.requireGuard(user, 'canReadHouseholds')
      const requestedLimit = Number.parseInt(query.limit, 10)
      const { items, nextCursor } = store.listHouseholdsPage(createFirmContext(user), {
        search: query.search || '',
        includeArchived: Boolean(query.includeArchived),
        cursor: decodeCursor(query.cursor),
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 50
      })
      return { items, nextCursor: encodeCursor(nextCursor) }
    },
    createHousehold(user, input) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.createHousehold(user, input))
    },
    addHouseholdMember(user, householdId, input) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.addHouseholdMember(user, householdId, input))
    },
    removeHouseholdMember(user, householdId, clientId) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.removeHouseholdMember(user, householdId, clientId))
    },
    linkSpouse(user, primaryClientId, spouseClientId) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.linkSpouse(user, primaryClientId, spouseClientId))
    },
    createSpouse(user, primaryClientId, spouse) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.createSpouse(user, primaryClientId, spouse))
    },
    archiveHousehold(user, householdId, input = {}) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.archiveHousehold(user, householdId, input))
    },
    restoreHousehold(user, householdId) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return runAuditedMutation(store, () => store.restoreHousehold(user, householdId))
    }
  }
}
