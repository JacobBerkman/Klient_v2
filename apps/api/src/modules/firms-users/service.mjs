export function createFirmsUsersService({ store }) {
  return {
    listUsers(user) { return store.listUsers(user); },
    inviteUser(user, input) { return store.inviteUser(user, input); },
    acceptInvite(input) { return store.acceptInvite(input); }
  };
}
