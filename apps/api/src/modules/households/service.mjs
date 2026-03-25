import { createFirmContext } from '../shared/tenancy.mjs'

export function createHouseholdsService({ store, policy }) {
  return {
    listHouseholds(user) {
      policy.requireGuard(user, 'canReadHouseholds')
      return store.listHouseholds(createFirmContext(user))
    },
    createHousehold(user, input) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return store.createHousehold(createFirmContext(user), input)
    },
    addHouseholdMember(user, householdId, input) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return store.addHouseholdMember(createFirmContext(user), householdId, input)
    },
    removeHouseholdMember(user, householdId, clientId) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return store.removeHouseholdMember(createFirmContext(user), householdId, clientId)
    },
    linkSpouse(user, primaryClientId, spouseClientId) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return store.linkSpouse(createFirmContext(user), primaryClientId, spouseClientId)
    },
    createSpouse(user, primaryClientId, spouse) {
      policy.requireGuard(user, 'canWriteHouseholds')
      return store.createSpouse(createFirmContext(user), primaryClientId, spouse)
    }
  }
}
