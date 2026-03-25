export function createAuthService({ store }) {
  return {
    register(input) {
      return store.auth.register(input)
    },
    login(input) {
      return store.auth.login(input)
    },
    requestReset(input) {
      return store.auth.requestReset(input)
    },
    resetPassword(input) {
      return store.auth.resetPassword(input)
    },
    enrollMfa(user) {
      return store.auth.startTotpEnrollment(user)
    },
    confirmMfaEnrollment(user, input) {
      return store.auth.confirmTotpEnrollment(user, input)
    },
    challengeMfa(user) {
      return store.auth.createMfaChallenge(user)
    },
    verifyMfaChallenge(user, input) {
      return store.auth.verifyMfaChallenge(user, input)
    },
    rotateMfaBackupCodes(user) {
      return store.auth.rotateBackupCodes(user)
    },
    logout(token) {
      return store.logout(token)
    },
    rotateSession(token, reason) {
      return store.rotateSession(token, reason)
    },
    requireUser(token) {
      return store.requireUser(token)
    }
  }
}
