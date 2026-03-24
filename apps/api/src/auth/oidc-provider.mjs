export function createOidcAuthProvider() {
  return {
    authenticate() {
      throw new Error('OIDC adapter not implemented.');
    },
    register() {
      throw new Error('OIDC adapter not implemented.');
    },
    requestReset() {
      throw new Error('OIDC adapter not implemented.');
    },
    resetPassword() {
      throw new Error('OIDC adapter not implemented.');
    },
    startTotpEnrollment() {
      throw new Error('OIDC adapter not implemented.');
    },
    confirmTotpEnrollment() {
      throw new Error('OIDC adapter not implemented.');
    },
    createMfaChallenge() {
      throw new Error('OIDC adapter not implemented.');
    },
    verifyMfaChallenge() {
      throw new Error('OIDC adapter not implemented.');
    },
    rotateBackupCodes() {
      throw new Error('OIDC adapter not implemented.');
    }
  };
}
