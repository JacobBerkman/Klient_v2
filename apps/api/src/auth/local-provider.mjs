import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDefaultFirmStageConfig } from '../stage-config.mjs'

const LOGIN_WINDOW_MS = 1000 * 60 * 15
const MAX_LOGIN_ATTEMPTS = 5
const MAX_LOGIN_ATTEMPTS_PER_IP = 25
const RESET_TTL_MS = 1000 * 60 * 30
const RESET_RATE_WINDOW_MS = 1000 * 60 * 60
const MAX_RESETS_PER_USER = 5
const MAX_RESETS_PER_IP = 10
const MFA_CHALLENGE_TTL_MS = 1000 * 60 * 10
const MFA_ENROLL_TTL_MS = 1000 * 60 * 10
const BACKUP_CODE_COUNT = 8

function nowIso() {
  return new Date().toISOString()
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex')
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const normalized = String(input || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/\s+/g, '')
  let bits = ''
  for (const char of normalized) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error('Invalid base32 input.')
    bits += index.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

function randomBase32(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let output = ''
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length]
  }
  return output
}

function computeTotp(secret, timeStep = Math.floor(Date.now() / 30000), digits = 6) {
  const key = base32Decode(secret)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(timeStep))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

function verifyTotpCode(secret, code, window = 1) {
  const normalizedCode = String(code || '').trim()
  const step = Math.floor(Date.now() / 30000)
  for (let drift = -window; drift <= window; drift += 1) {
    if (computeTotp(secret, step + drift) === normalizedCode) return true
  }
  return false
}

function assertStrongPassword(password) {
  const value = String(password || '')
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.')
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.')
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function sanitizeIp(ipAddress) {
  return String(ipAddress || 'unknown').slice(0, 128)
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase()
}

function pruneByAge(records, maxAgeMs, dateField = 'createdAt') {
  return records.filter((entry) => Date.now() - new Date(entry[dateField]).getTime() <= maxAgeMs)
}

export function createLocalAuthProvider({ state, persist, createSession, addAudit, deleteSessionsByUser = () => [] }) {

  function clearLoginAttempts(email) {
    const normalizedEmail = normalizeEmail(email)
    state.authAttempts = (state.authAttempts || []).filter((attempt) => attempt.email !== normalizedEmail)
  }

  function clearUserLockout(user) {
    if (!user?.security?.lockoutUntil) return false
    user.security.lockoutUntil = null
    user.security.lockedAt = null
    return true
  }

  function ensureLoginAllowed(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email)
    const normalizedIp = sanitizeIp(ipAddress)
    state.authAttempts = pruneByAge(state.authAttempts || [], LOGIN_WINDOW_MS)

    const byEmailFailures = state.authAttempts.filter((attempt) => attempt.email === normalizedEmail && !attempt.ok)
    if (byEmailFailures.length >= MAX_LOGIN_ATTEMPTS) {
      throw new Error('Too many failed login attempts. Please wait 15 minutes and try again.')
    }

    const byIpFailures = state.authAttempts.filter((attempt) => attempt.ipAddress === normalizedIp && !attempt.ok)
    if (byIpFailures.length >= MAX_LOGIN_ATTEMPTS_PER_IP) {
      throw new Error('Too many failed login attempts from this IP. Please wait 15 minutes and try again.')
    }

    const user = state.users.find((entry) => entry.email === normalizedEmail)
    const lockoutUntil = new Date(user?.security?.lockoutUntil || 0).getTime()
    if (lockoutUntil > Date.now()) {
      throw new Error('Account is temporarily locked due to failed login attempts.')
    }
    if (user && user?.security?.lockoutUntil) {
      clearUserLockout(user)
      persist()
    }
  }

  function registerFailedLogin(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email)
    const normalizedIp = sanitizeIp(ipAddress)
    state.authAttempts = pruneByAge(state.authAttempts || [], LOGIN_WINDOW_MS)
    state.authAttempts.push({
      id: randomUUID(),
      email: normalizedEmail,
      ipAddress: normalizedIp,
      ok: false,
      createdAt: nowIso()
    })

    const user = state.users.find((entry) => entry.email === normalizedEmail)
    if (user) {
      user.security ||= {}
      user.security.failedLoginCount = Number(user.security.failedLoginCount || 0) + 1
      user.security.lastFailedLoginAt = nowIso()
      if (user.security.failedLoginCount >= MAX_LOGIN_ATTEMPTS) {
        user.security.lockedAt = nowIso()
        user.security.lockoutUntil = new Date(Date.now() + LOGIN_WINDOW_MS).toISOString()
      }
    }
    persist()
  }

  function registerSuccessfulLogin(user, ipAddress) {
    const normalizedEmail = normalizeEmail(user.email)
    const normalizedIp = sanitizeIp(ipAddress)
    state.authAttempts = pruneByAge(state.authAttempts || [], LOGIN_WINDOW_MS)
    state.authAttempts.push({
      id: randomUUID(),
      email: normalizedEmail,
      ipAddress: normalizedIp,
      ok: true,
      createdAt: nowIso()
    })
    clearLoginAttempts(normalizedEmail)
    user.security ||= {}
    user.security.failedLoginCount = 0
    user.security.lastSuccessfulLoginAt = nowIso()
    clearUserLockout(user)
    persist()
  }

  function ensureResetRateLimit(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email)
    const normalizedIp = sanitizeIp(ipAddress)
    state.passwordResetAttempts = pruneByAge(state.passwordResetAttempts || [], RESET_RATE_WINDOW_MS)
    const byUser = state.passwordResetAttempts.filter((attempt) => attempt.email === normalizedEmail)
    const byIp = state.passwordResetAttempts.filter((attempt) => attempt.ipAddress === normalizedIp)
    if (byUser.length >= MAX_RESETS_PER_USER) throw new Error('Too many password reset requests for this user.')
    if (byIp.length >= MAX_RESETS_PER_IP) throw new Error('Too many password reset requests from this IP.')
    state.passwordResetAttempts.push({
      id: randomUUID(),
      email: normalizedEmail,
      ipAddress: normalizedIp,
      createdAt: nowIso()
    })
  }

  function ensureMfaData(user) {
    user.mfa ||= { enabled: false, totpSecret: null, backupCodes: [] }
    user.mfa.backupCodes ||= []
    return user.mfa
  }

  function createBackupCodes() {
    const plainCodes = []
    const hashedCodes = []
    for (let idx = 0; idx < BACKUP_CODE_COUNT; idx += 1) {
      const code = randomBytes(4).toString('hex').toUpperCase()
      plainCodes.push(code)
      hashedCodes.push(hash(code))
    }
    return { plainCodes, hashedCodes }
  }

  function consumeBackupCode(user, backupCode) {
    const mfa = ensureMfaData(user)
    const lookup = hash(
      String(backupCode || '')
        .trim()
        .toUpperCase()
    )
    const index = mfa.backupCodes.findIndex((entry) => entry === lookup)
    if (index === -1) return false
    mfa.backupCodes.splice(index, 1)
    return true
  }

  function createAndPersistMfaChallenge(userId, method = 'totp') {
    state.mfaChallenges = pruneByAge(state.mfaChallenges || [], MFA_CHALLENGE_TTL_MS)
    const challenge = {
      id: randomUUID(),
      token: randomUUID(),
      userId,
      method,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString()
    }
    state.mfaChallenges.push(challenge)
    persist()
    return challenge
  }
  function revokeUserSessions(userId) {
    // The sessions table is the sole source of truth for sessions: revoke
    // straight from it and report how many rows were deleted.
    return deleteSessionsByUser(userId).length
  }


  return {
    providerId: 'local',
    authenticate({ email, password, mfaChallengeToken, totpCode, backupCode, ipAddress }) {
      const normalizedEmail = normalizeEmail(email)
      ensureLoginAllowed(normalizedEmail, ipAddress)
      const user = state.users.find((entry) => entry.email === normalizedEmail && entry.passwordHash === hash(password))
      if (!user) {
        const existingUser = state.users.find((entry) => entry.email === normalizedEmail)
        registerFailedLogin(normalizedEmail, ipAddress)
        addAudit(existingUser?.firmId || 'system', existingUser?.id || null, 'auth', normalizedEmail, 'auth.login.failed', {
          after: { email: normalizedEmail, reason: 'invalid_credentials' }
        })
        throw new Error('Invalid email or password.')
      }
      registerSuccessfulLogin(user, ipAddress)
      const mfa = ensureMfaData(user)
      if (!mfa.enabled) {
        addAudit(user.firmId, user.id, 'user', user.id, 'auth.login.succeeded', {
          after: { email: normalizedEmail, mfaEnabled: false }
        })
        return createSession(user)
      }

      if (!mfaChallengeToken) {
        const challenge = createAndPersistMfaChallenge(user.id)
        addAudit(user.firmId, user.id, 'user', user.id, 'auth.mfa.challenge_issued', {
          after: { challengeToken: challenge.token, method: challenge.method }
        })
        return { mfaRequired: true, challengeToken: challenge.token, methods: ['totp', 'backup_code'] }
      }

      const challenge = state.mfaChallenges.find(
        (entry) => entry.token === mfaChallengeToken && entry.userId === user.id
      )
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
        throw new Error('MFA challenge expired or not found.')
      }

      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false
      const backupValid = backupCode ? consumeBackupCode(user, backupCode) : false
      if (!totpValid && !backupValid) {
        persist()
        addAudit(user.firmId, user.id, 'user', user.id, 'auth.mfa.challenge_failed', { after: { challengeId: challenge.id } })
        throw new Error('Invalid MFA verification code.')
      }

      state.mfaChallenges = state.mfaChallenges.filter((entry) => entry.id !== challenge.id)
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.login.succeeded', {
        after: { email: normalizedEmail, mfaEnabled: true, challengeId: challenge.id }
      })
      persist()
      return createSession(user)
    },
    register({ firmName, firstName, lastName, email, password }) {
      assertStrongPassword(password)
      const normalizedEmail = normalizeEmail(email)
      if (state.users.some((user) => user.email === normalizedEmail))
        throw new Error('An account with this email already exists.')
      const firm = {
        id: randomUUID(),
        name: firmName,
        slug: slugify(firmName),
        stageConfig: createDefaultFirmStageConfig(),
        createdAt: nowIso()
      }
      const user = {
        id: randomUUID(),
        firmId: firm.id,
        email: normalizedEmail,
        passwordHash: hash(password),
        firstName,
        lastName,
        role: 'admin',
        authProvider: 'local',
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        createdAt: nowIso()
      }
      state.firms.push(firm)
      state.users.push(user)
      addAudit(firm.id, user.id, 'firm', firm.id, 'firm.created', { name: firm.name })
      return createSession(user)
    },
    acceptInvite({ token, firstName, lastName, password }) {
      assertStrongPassword(password)
      const invite = (state.invites || []).find((entry) => entry.token === token)
      if (!invite) throw new Error('Invite not found.')
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
        throw new Error('Invite expired.')
      }
      const existingUser = state.users.find((entry) => entry.email === invite.email && entry.firmId === invite.firmId)
      if (existingUser) throw new Error('Invite email is already associated with an account.')

      const user = {
        id: randomUUID(),
        firmId: invite.firmId,
        email: invite.email,
        passwordHash: hash(password),
        firstName,
        lastName,
        role: invite.role,
        authProvider: 'local',
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        security: { failedLoginCount: 0, lockoutUntil: null, lockedAt: null },
        createdAt: nowIso()
      }

      state.users.push(user)
      state.invites = (state.invites || []).filter((entry) => entry.id !== invite.id)
      addAudit(invite.firmId, user.id, 'invite', invite.id, 'invite.accepted', { email: invite.email, role: invite.role })
      persist()
      return createSession(user)
    },
    requestReset({ email, ipAddress }) {
      const normalizedEmail = normalizeEmail(email)
      ensureResetRateLimit(normalizedEmail, ipAddress)
      const user = state.users.find((entry) => entry.email === normalizedEmail)
      if (!user) {
        persist()
        return { ok: true }
      }
      state.passwordResets = (state.passwordResets || []).filter((entry) => entry.userId !== user.id)
      const reset = {
        id: randomUUID(),
        userId: user.id,
        token: randomUUID(),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString()
      }
      state.passwordResets.push(reset)
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.requested', {
        ipAddress: sanitizeIp(ipAddress)
      })
      persist()
      return reset
    },
    resetPassword({ token, password }) {
      assertStrongPassword(password)
      const reset = state.passwordResets.find((entry) => entry.token === token)
      if (!reset) throw new Error('Reset token not found.')
      if (new Date(reset.expiresAt).getTime() <= Date.now()) {
        state.passwordResets = state.passwordResets.filter((entry) => entry.id !== reset.id)
        persist()
        throw new Error('Reset token expired.')
      }
      const user = state.users.find((entry) => entry.id === reset.userId)
      if (!user) throw new Error('User not found.')
      user.passwordHash = hash(password)
      user.security ||= {}
      user.security.failedLoginCount = 0
      user.security.lockoutUntil = null
      user.security.lockedAt = null
      state.passwordResets = state.passwordResets.filter((entry) => entry.userId !== user.id)
      state.mfaChallenges = (state.mfaChallenges || []).filter((entry) => entry.userId !== user.id)
      const revokedSessions = revokeUserSessions(user.id)
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.completed', { revokedSessions })
      persist()
      return { ok: true, revokedSessions }
    },
    startTotpEnrollment(user) {
      const actor = state.users.find((entry) => entry.id === user.id)
      if (!actor) throw new Error('User not found.')
      const secret = randomBase32(32)
      const enrollment = {
        id: randomUUID(),
        token: randomUUID(),
        userId: actor.id,
        secret,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + MFA_ENROLL_TTL_MS).toISOString()
      }
      state.mfaEnrollments = pruneByAge(state.mfaEnrollments || [], MFA_ENROLL_TTL_MS)
      state.mfaEnrollments.push(enrollment)
      persist()
      const issuer = encodeURIComponent('Klient')
      const label = encodeURIComponent(actor.email)
      return {
        enrollmentToken: enrollment.token,
        secret,
        otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
      }
    },
    confirmTotpEnrollment(user, { enrollmentToken, code }) {
      const actor = state.users.find((entry) => entry.id === user.id)
      if (!actor) throw new Error('User not found.')
      const enrollment = (state.mfaEnrollments || []).find(
        (entry) => entry.token === enrollmentToken && entry.userId === actor.id
      )
      if (!enrollment || new Date(enrollment.expiresAt).getTime() <= Date.now()) {
        throw new Error('MFA enrollment challenge expired or not found.')
      }
      if (!verifyTotpCode(enrollment.secret, code)) throw new Error('Invalid MFA verification code.')
      const mfa = ensureMfaData(actor)
      const { plainCodes, hashedCodes } = createBackupCodes()
      mfa.enabled = true
      mfa.totpSecret = enrollment.secret
      mfa.backupCodes = hashedCodes
      state.mfaEnrollments = state.mfaEnrollments.filter((entry) => entry.id !== enrollment.id)
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.enabled', { method: 'totp' })
      persist()
      return { ok: true, backupCodes: plainCodes }
    },
    createMfaChallenge(user) {
      const actor = state.users.find((entry) => entry.id === user.id)
      if (!actor) throw new Error('User not found.')
      const challenge = createAndPersistMfaChallenge(actor.id)
      return { challengeToken: challenge.token, methods: ['totp', 'backup_code'] }
    },
    verifyMfaChallenge(user, { challengeToken, totpCode, backupCode }) {
      const actor = state.users.find((entry) => entry.id === user.id)
      if (!actor) throw new Error('User not found.')
      const mfa = ensureMfaData(actor)
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.')
      const challenge = (state.mfaChallenges || []).find(
        (entry) => entry.token === challengeToken && entry.userId === actor.id
      )
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now())
        throw new Error('MFA challenge expired or not found.')
      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false
      const backupValid = backupCode ? consumeBackupCode(actor, backupCode) : false
      if (!totpValid && !backupValid) {
        persist()
        throw new Error('Invalid MFA verification code.')
      }
      state.mfaChallenges = state.mfaChallenges.filter((entry) => entry.id !== challenge.id)
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.challenge_verified', {
        after: { challengeId: challenge.id }
      })
      persist()
      return { ok: true }
    },
    rotateBackupCodes(user) {
      const actor = state.users.find((entry) => entry.id === user.id)
      if (!actor) throw new Error('User not found.')
      const mfa = ensureMfaData(actor)
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.')
      const { plainCodes, hashedCodes } = createBackupCodes()
      mfa.backupCodes = hashedCodes
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.backup_codes_rotated', {})
      persist()
      return { backupCodes: plainCodes }
    }
  }
}

export const __testUtils = {
  computeTotp,
  verifyTotpCode
}
