export function assertAuthProvider(provider) {
  const requiredMethods = [
    'authenticate',
    'register',
    'requestReset',
    'resetPassword',
    'startTotpEnrollment',
    'confirmTotpEnrollment',
    'createMfaChallenge',
    'verifyMfaChallenge',
    'rotateBackupCodes'
  ]
  for (const method of requiredMethods) {
    if (typeof provider?.[method] !== 'function') {
      throw new Error(`Invalid auth provider: missing ${method}().`)
    }
  }
  return provider
}
