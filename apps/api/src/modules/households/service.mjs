export function createHouseholdsService({ householdsRepository }) {
  return {
    listHouseholds(user) { return householdsRepository.listHouseholds(user); },
    createHousehold(user, input) { return householdsRepository.createHousehold(user, input); },
    addHouseholdMember(user, householdId, input) { return householdsRepository.addHouseholdMember(user, householdId, input); },
    removeHouseholdMember(user, householdId, clientId) { return householdsRepository.removeHouseholdMember(user, householdId, clientId); },
    linkSpouse(user, primaryClientId, spouseClientId) { return householdsRepository.linkSpouse(user, primaryClientId, spouseClientId); },
    createSpouse(user, primaryClientId, spouse) { return householdsRepository.createSpouse(user, primaryClientId, spouse); }
export function createHouseholdsService({ store, policy }) {
  return {
    listHouseholds(user) { policy.requireGuard(user, 'canReadHouseholds'); return store.listHouseholds(user); },
    createHousehold(user, input) { policy.requireGuard(user, 'canWriteHouseholds'); return store.createHousehold(user, input); },
    addHouseholdMember(user, householdId, input) { policy.requireGuard(user, 'canWriteHouseholds'); return store.addHouseholdMember(user, householdId, input); },
    removeHouseholdMember(user, householdId, clientId) { policy.requireGuard(user, 'canWriteHouseholds'); return store.removeHouseholdMember(user, householdId, clientId); },
    linkSpouse(user, primaryClientId, spouseClientId) { policy.requireGuard(user, 'canWriteHouseholds'); return store.linkSpouse(user, primaryClientId, spouseClientId); },
    createSpouse(user, primaryClientId, spouse) { policy.requireGuard(user, 'canWriteHouseholds'); return store.createSpouse(user, primaryClientId, spouse); }
  };
}
