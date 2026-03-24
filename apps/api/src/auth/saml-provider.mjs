export function createSamlAuthProvider() {
  return {
    authenticate() {
      throw new Error('SAML adapter not implemented.');
    },
    register() {
      throw new Error('SAML adapter not implemented.');
    },
    requestReset() {
      throw new Error('SAML adapter not implemented.');
    },
    resetPassword() {
      throw new Error('SAML adapter not implemented.');
    },
    startTotpEnrollment() {
      throw new Error('SAML adapter not implemented.');
    },
    confirmTotpEnrollment() {
      throw new Error('SAML adapter not implemented.');
    },
    createMfaChallenge() {
      throw new Error('SAML adapter not implemented.');
    },
    verifyMfaChallenge() {
      throw new Error('SAML adapter not implemented.');
    },
    rotateBackupCodes() {
      throw new Error('SAML adapter not implemented.');
    }
  };
}
