export function createAuthService({ store }) {
  return {
    register(input) { return store.auth.register(input); },
    login(input) { return store.auth.login(input); },
    requestReset(input) { return store.auth.requestReset(input); },
    resetPassword(input) { return store.auth.resetPassword(input); },
    logout(token) { return store.logout(token); },
    requireUser(token) { return store.requireUser(token); }
  };
}
