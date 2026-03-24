export function createHouseholdsService({ store }) {
  return {
    listHouseholds(user) { return store.listHouseholds(user); },
    createHousehold(user, input) { return store.createHousehold(user, input); },
    addHouseholdMember(user, householdId, input) { return store.addHouseholdMember(user, householdId, input); },
    removeHouseholdMember(user, householdId, clientId) { return store.removeHouseholdMember(user, householdId, clientId); },
    linkSpouse(user, primaryClientId, spouseClientId) { return store.linkSpouse(user, primaryClientId, spouseClientId); },
    createSpouse(user, primaryClientId, spouse) { return store.createSpouse(user, primaryClientId, spouse); }
  };
}
