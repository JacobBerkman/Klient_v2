import { runAuditedMutation } from '../audit/service.mjs'
import { createFirmContext } from '../shared/tenancy.mjs'

export function createHouseholdsService({ store, policy }) {
  return {
    listHouseholds(user) {
      policy.requireGuard(user, 'canReadHouseholds')
      return store.listHouseholds(createFirmContext(user))
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
    }
  }
}
