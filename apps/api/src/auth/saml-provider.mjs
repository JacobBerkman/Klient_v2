import { randomUUID } from 'node:crypto'

function nowIso() {
  return new Date().toISOString()
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function slugify(value) {
  return (
    String(value || 'firm')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'firm'
  )
}

function pickFirst(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return null
}

function normalizeClaims(rawClaims) {
  const claims = rawClaims || {}
  const email = normalizeEmail(pickFirst(claims, ['email', 'mail', 'EmailAddress', 'nameID']))
  const subject = String(pickFirst(claims, ['nameID', 'name_id', 'subject', 'id']) || '').trim()
  if (!email) throw new Error('SAML claims missing email.')
  if (!subject) throw new Error('SAML claims missing subject.')
  return {
    subject,
    email,
    firstName: String(pickFirst(claims, ['firstName', 'givenName', 'given_name']) || '').trim() || 'Unknown',
    lastName: String(pickFirst(claims, ['lastName', 'sn', 'family_name']) || '').trim() || 'User',
    organization: String(pickFirst(claims, ['company', 'organization', 'org']) || '').trim() || null,
    amr: Array.isArray(claims.amr) ? claims.amr : []
  }
}

function ensureArrays(state) {
  state.users ||= []
  state.firms ||= []
  state.externalIdentities ||= []
}

function createFederatedProvider({
  provider,
  hooks = {},
  state,
  persist = () => {},
  createSession,
  addAudit = () => {},
  fallbackProvider = null
}) {
  function maybeFallback(method, input, user) {
    if (fallbackProvider?.[method]) {
      return user ? fallbackProvider[method](user, input) : fallbackProvider[method](input)
    }
    throw new Error(`${provider.toUpperCase()} provider is not configured for ${method}.`)
  }

  function mapIdentity(claims, input = {}) {
    if (!state || typeof createSession !== 'function')
      throw new Error(`${provider.toUpperCase()} provider requires state and createSession.`)
    ensureArrays(state)

    const normalized = normalizeClaims(claims)
    const identity = state.externalIdentities.find(
      (entry) => entry.provider === provider && entry.subject === normalized.subject
    )
    let user = identity ? state.users.find((entry) => entry.id === identity.userId) : null

    const invitedEmail = normalizeEmail(input?.invite?.email)
    if (!user && input?.invite?.firmId) {
      user = state.users.find((entry) => entry.firmId === input.invite.firmId && entry.email === normalized.email)
      if (invitedEmail && normalized.email !== invitedEmail) {
        throw new Error('Invite email does not match authenticated provider identity.')
      }
    }

    if (!user) {
      let firmId = input?.invite?.firmId || null
      if (!firmId) {
        const firmName =
          input?.firmName || normalized.organization || `${normalized.firstName} ${normalized.lastName} Advisory`
        const firm = {
          id: randomUUID(),
          name: firmName,
          slug: slugify(firmName),
          createdAt: nowIso()
        }
        state.firms.push(firm)
        firmId = firm.id
      }
      user = {
        id: randomUUID(),
        firmId,
        email: normalized.email,
        passwordHash: null,
        firstName: normalized.firstName,
        lastName: normalized.lastName,
        role: input?.invite?.role || input?.role || 'admin',
        authProvider: provider,
        mfa: { enabled: normalized.amr.includes('mfa'), totpSecret: null, backupCodes: [] },
        createdAt: nowIso()
      }
      state.users.push(user)
    } else {
      user.email = normalized.email
      user.firstName = normalized.firstName
      user.lastName = normalized.lastName
      user.authProvider = provider
      user.mfa ||= { enabled: false, totpSecret: null, backupCodes: [] }
      if (normalized.amr.includes('mfa')) user.mfa.enabled = true
    }

    if (identity) {
      identity.userId = user.id
      identity.email = normalized.email
      identity.lastClaims = normalized
      identity.updatedAt = nowIso()
      identity.lastLoginAt = nowIso()
    } else {
      state.externalIdentities.push({
        id: randomUUID(),
        provider,
        subject: normalized.subject,
        userId: user.id,
        email: normalized.email,
        lastClaims: normalized,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastLoginAt: nowIso()
      })
    }

    persist()
    addAudit(user.firmId, user.id, 'user', user.id, 'auth.federated.sync', { provider, subject: normalized.subject })
    return user
  }

  return {
    providerId: 'saml',
    authenticate(input = {}) {
      if (typeof hooks.authenticate !== 'function') return maybeFallback('authenticate', input)
      const result = hooks.authenticate(input)
      if (result?.mfaRequired) return result
      const user = mapIdentity(result?.claims || result?.user || result, input)
      return createSession(user)
    },
    register(input = {}) {
      if (typeof hooks.register !== 'function') return maybeFallback('register', input)
      const result = hooks.register(input)
      const user = mapIdentity(result?.claims || result?.user || result, input)
      return createSession(user)
    },
    acceptInvite(input = {}) {
      if (typeof hooks.acceptInvite === 'function') return hooks.acceptInvite(input)
      return { ok: true, providerManaged: true, provider }
    },
    requestReset(input = {}) {
      if (typeof hooks.requestReset !== 'function') return { ok: true, providerManaged: true, provider }
      return hooks.requestReset(input)
    },
    resetPassword(input = {}) {
      if (typeof hooks.resetPassword !== 'function') return { ok: true, providerManaged: true, provider }
      return hooks.resetPassword(input)
    },
    startTotpEnrollment(user) {
      if (typeof hooks.startTotpEnrollment !== 'function') return { ok: true, providerManaged: true, provider }
      return hooks.startTotpEnrollment(user)
    },
    confirmTotpEnrollment(user, input = {}) {
      if (typeof hooks.confirmTotpEnrollment !== 'function') return { ok: true, providerManaged: true, provider }
      return hooks.confirmTotpEnrollment(user, input)
    },
    createMfaChallenge(user) {
      if (typeof hooks.createMfaChallenge !== 'function')
        return { ok: true, providerManaged: true, provider, methods: ['provider'] }
      return hooks.createMfaChallenge(user)
    },
    verifyMfaChallenge(user, input = {}) {
      if (typeof hooks.verifyMfaChallenge !== 'function') return { ok: true, providerManaged: true, provider }
      return hooks.verifyMfaChallenge(user, input)
    },
    rotateBackupCodes(user) {
      if (typeof hooks.rotateBackupCodes !== 'function') return { backupCodes: [], providerManaged: true, provider }
      return hooks.rotateBackupCodes(user)
    }
  }
}

export function createSamlAuthProvider(options = {}) {
  return createFederatedProvider({ provider: 'saml', ...options })
}
