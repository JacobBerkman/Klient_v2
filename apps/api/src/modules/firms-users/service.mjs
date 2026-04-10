export function createFirmsUsersService({ store, policy }) {
  return {
    listUsers(user, query = {}) {
      policy.requireGuard(user, 'canReadUsers')
      return store.listUsers(user, query)
    },
    inviteUser(user, input) {
      policy.requireGuard(user, 'canManageUsers')
      return store.inviteUser(user, input)
    },
    acceptInvite(input) {
      return store.acceptInvite(input)
    }
  }
}
