import { assertAuthProvider } from './provider-interface.mjs';

export function createAuthService({ provider }) {
  const authProvider = assertAuthProvider(provider);

  return {
    register(input) {
      return authProvider.register(input);
    },
    login(input) {
      return authProvider.authenticate(input);
    },
    requestReset(input) {
      return authProvider.requestReset(input);
    },
    resetPassword(input) {
      return authProvider.resetPassword(input);
    },
    startTotpEnrollment(user) {
      return authProvider.startTotpEnrollment(user);
    },
    confirmTotpEnrollment(user, input) {
      return authProvider.confirmTotpEnrollment(user, input);
    },
    createMfaChallenge(user) {
      return authProvider.createMfaChallenge(user);
    },
    verifyMfaChallenge(user, input) {
      return authProvider.verifyMfaChallenge(user, input);
    },
    rotateBackupCodes(user) {
      return authProvider.rotateBackupCodes(user);
    }
  };
}
