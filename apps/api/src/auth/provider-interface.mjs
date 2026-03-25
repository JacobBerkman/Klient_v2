const PROVIDER_METHODS = [
  'authenticate',
  'register',
  'acceptInvite',
  'requestReset',
  'resetPassword',
  'startTotpEnrollment',
  'confirmTotpEnrollment',
  'createMfaChallenge',
  'verifyMfaChallenge',
  'rotateBackupCodes'
]

const KNOWN_PROVIDERS = ['local', 'oidc', 'saml']

export function providerContract() {
  return {
    knownProviders: [...KNOWN_PROVIDERS],
    requiredMethods: [...PROVIDER_METHODS]
  }
}

export function assertAuthProvider(provider) {
  const missingMethods = PROVIDER_METHODS.filter((method) => typeof provider?.[method] !== 'function')
  if (missingMethods.length) {
    throw new Error(`Invalid auth provider: missing ${missingMethods.join(', ')}().`)
  }

  if (provider.providerId) {
    const normalized = String(provider.providerId).toLowerCase()
    if (!KNOWN_PROVIDERS.includes(normalized)) {
      throw new Error(
        `Invalid auth provider: unknown providerId "${provider.providerId}". Expected one of ${KNOWN_PROVIDERS.join(', ')}.`
      )
    }
  }

  return provider
}
