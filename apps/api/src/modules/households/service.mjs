export function createHouseholdsService({ householdsRepository }) {
  return {
    listHouseholds(user) { return householdsRepository.listHouseholds(user); },
    createHousehold(user, input) { return householdsRepository.createHousehold(user, input); },
    addHouseholdMember(user, householdId, input) { return householdsRepository.addHouseholdMember(user, householdId, input); },
    removeHouseholdMember(user, householdId, clientId) { return householdsRepository.removeHouseholdMember(user, householdId, clientId); },
    linkSpouse(user, primaryClientId, spouseClientId) { return householdsRepository.linkSpouse(user, primaryClientId, spouseClientId); },
    createSpouse(user, primaryClientId, spouse) { return householdsRepository.createSpouse(user, primaryClientId, spouse); }
  };
}
