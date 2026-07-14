import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDefaultFirmStageConfig } from '../stage-config.mjs'
import { hashPassword, verifyPassword } from './passwords.mjs'
import {
  deleteInviteRow,
  findInviteRowByToken,
  getUserByEmail,
  getUserRow,
  upsertFirmRow,
  upsertUserRow,
  insertAuthAttempt,
  countFailedLoginsByEmail,
  countFailedLoginsByIp,
  deleteAuthAttemptsByEmail,
  insertPasswordResetAttempt,
  countResetAttemptsByEmail,
  countResetAttemptsByIp,
  insertPasswordReset,
  findPasswordResetByToken,
  deletePasswordResetsByUser,
  deletePasswordResetById,
  insertMfaChallenge,
  findMfaChallengeByTokenAndUser,
  deleteMfaChallengesByUser,
  deleteMfaChallengeById
} from '../storage.mjs'

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

// Verified against when no account matches the submitted email, so that the
// unknown-email path performs the same scrypt work as the known-email path.
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'))

function nowIso() {
  return new Date().toISOString()
}

// Backup codes are high-entropy random values, not user-chosen secrets, so a
// fast digest is appropriate here. Passwords go through scrypt (passwords.mjs).
function hashBackupCode(code) {
  return createHash('sha256').update(String(code || '')).digest('hex')
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
    // authAttempts is a relational source of truth now: clearing means deleting
    // every attempt row for the email.
    deleteAuthAttemptsByEmail(normalizeEmail(email))
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
    // Only attempts inside the rolling window count. The old pruneByAge dropped
    // rows older than the window; the SQL equivalent counts rows whose
    // created_at is strictly after the window cutoff.
    const loginCutoff = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString()

    if (countFailedLoginsByEmail(normalizedEmail, loginCutoff) >= MAX_LOGIN_ATTEMPTS) {
      throw new Error('Too many failed login attempts. Please wait 15 minutes and try again.')
    }

    if (countFailedLoginsByIp(normalizedIp, loginCutoff) >= MAX_LOGIN_ATTEMPTS_PER_IP) {
      throw new Error('Too many failed login attempts from this IP. Please wait 15 minutes and try again.')
    }

    // users is a relational source of truth (migration 009): read by email.
    const user = getUserByEmail(normalizedEmail)
    const lockoutUntil = new Date(user?.security?.lockoutUntil || 0).getTime()
    if (lockoutUntil > Date.now()) {
      throw new Error('Account is temporarily locked due to failed login attempts.')
    }
    if (user && user?.security?.lockoutUntil) {
      clearUserLockout(user)
      // The lockout-clear is an in-place user mutation: it must be upserted
      // (persist() no longer flushes user rows).
      upsertUserRow(user)
    }
  }

  function registerFailedLogin(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email)
    const normalizedIp = sanitizeIp(ipAddress)
    // Insert the failed attempt, pruning rows past the window first (mirrors
    // pruneByAge running on every write) to bound table growth.
    const loginCutoff = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString()
    insertAuthAttempt(
      { id: randomUUID(), email: normalizedEmail, ipAddress: normalizedIp, ok: false, createdAt: nowIso() },
      { pruneCutoff: loginCutoff }
    )

    const user = getUserByEmail(normalizedEmail)
    if (user) {
      user.security ||= {}
      user.security.failedLoginCount = Number(user.security.failedLoginCount || 0) + 1
      user.security.lastFailedLoginAt = nowIso()
      if (user.security.failedLoginCount >= MAX_LOGIN_ATTEMPTS) {
        user.security.lockedAt = nowIso()
        user.security.lockoutUntil = new Date(Date.now() + LOGIN_WINDOW_MS).toISOString()
      }
      // The incremented failed-login counter / lockout window is an in-place
      // user mutation and MUST be upserted — otherwise lockout never triggers.
      upsertUserRow(user)
    }
  }

  function registerSuccessfulLogin(user) {
    const normalizedEmail = normalizeEmail(user.email)
    // The old code inserted an ok=1 row then clearLoginAttempts deleted every
    // row for the email (including the one just inserted). The net effect is
    // simply "no attempts remain for this email".
    clearLoginAttempts(normalizedEmail)
    user.security ||= {}
    user.security.failedLoginCount = 0
    user.security.lastSuccessfulLoginAt = nowIso()
    clearUserLockout(user)
    // Reset counters / cleared lockout are in-place user mutations: upsert them.
    upsertUserRow(user)
  }

  function ensureResetRateLimit(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email)
    const normalizedIp = sanitizeIp(ipAddress)
    // Only reset requests inside the rolling hour count (SQL equivalent of
    // pruneByAge(RESET_RATE_WINDOW_MS) then filter/count).
    const resetCutoff = new Date(Date.now() - RESET_RATE_WINDOW_MS).toISOString()
    if (countResetAttemptsByEmail(normalizedEmail, resetCutoff) >= MAX_RESETS_PER_USER) {
      throw new Error('Too many password reset requests for this user.')
    }
    if (countResetAttemptsByIp(normalizedIp, resetCutoff) >= MAX_RESETS_PER_IP) {
      throw new Error('Too many password reset requests from this IP.')
    }
    // Record this request, pruning past-window rows first to bound growth.
    insertPasswordResetAttempt(
      { id: randomUUID(), email: normalizedEmail, ipAddress: normalizedIp, createdAt: nowIso() },
      { pruneCutoff: resetCutoff }
    )
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
      // 8 bytes = 64 bits of entropy; 4 bytes was brute-forceable offline if the
      // hashed codes ever leaked. Older 8-char codes still verify unchanged.
      const code = randomBytes(8).toString('hex').toUpperCase()
      plainCodes.push(code)
      hashedCodes.push(hashBackupCode(code))
    }
    return { plainCodes, hashedCodes }
  }

  function consumeBackupCode(user, backupCode) {
    const mfa = ensureMfaData(user)
    const lookup = hashBackupCode(
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
    const challenge = {
      id: randomUUID(),
      token: randomUUID(),
      userId,
      method,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString()
    }
    // mfaChallenges is relational: the insert is the durable write (no persist()
    // needed — this function mutated no other blob state). Prune expired
    // challenges (expires_at <= now, equivalent to the old pruneByAge on
    // createdAt + TTL) first to bound table growth.
    insertMfaChallenge(challenge, { pruneCutoff: nowIso() })
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
      const existingUser = getUserByEmail(normalizedEmail)
      // Always run a verification so an unknown email costs the same scrypt work
      // as a known one — otherwise the timing difference enumerates accounts.
      const verification = existingUser
        ? verifyPassword(password, existingUser.passwordHash)
        : verifyPassword(password, DUMMY_PASSWORD_HASH)
      const user = existingUser && verification.verified ? existingUser : null
      if (!user) {
        registerFailedLogin(normalizedEmail, ipAddress)
        addAudit(existingUser?.firmId || 'system', existingUser?.id || null, 'auth', normalizedEmail, 'auth.login.failed', {
          after: { email: normalizedEmail, reason: 'invalid_credentials' }
        })
        throw new Error('Invalid email or password.')
      }
      registerSuccessfulLogin(user)
      if (verification.needsRehash) {
        // Legacy unsalted-SHA256 hash: upgrade to scrypt now that we hold the
        // plaintext. The upsert is the durable write.
        user.passwordHash = hashPassword(password)
        upsertUserRow(user)
        addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_hash.upgraded', {
          after: { algorithm: 'scrypt' }
        })
      }
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

      const challenge = findMfaChallengeByTokenAndUser(mfaChallengeToken, user.id)
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
        throw new Error('MFA challenge expired or not found.')
      }

      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false
      const backupValid = backupCode ? consumeBackupCode(user, backupCode) : false
      if (!totpValid && !backupValid) {
        addAudit(user.firmId, user.id, 'user', user.id, 'auth.mfa.challenge_failed', { after: { challengeId: challenge.id } })
        throw new Error('Invalid MFA verification code.')
      }

      // mfaChallenges is relational: consume the challenge by id.
      deleteMfaChallengeById(challenge.id)
      // A consumed backup code (splice) is an in-place user mutation: upsert it.
      upsertUserRow(user)
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.login.succeeded', {
        after: { email: normalizedEmail, mfaEnabled: true, challengeId: challenge.id }
      })
      return createSession(user)
    },
    register({ firmName, firstName, lastName, email, password }) {
      assertStrongPassword(password)
      const normalizedEmail = normalizeEmail(email)
      if (getUserByEmail(normalizedEmail)) throw new Error('An account with this email already exists.')
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
        passwordHash: hashPassword(password),
        firstName,
        lastName,
        role: 'admin',
        authProvider: 'local',
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        createdAt: nowIso()
      }
      // firms and users are source-of-truth tables now: targeted upserts create
      // the new firm + admin user (persist() no longer flushes either).
      upsertFirmRow(firm)
      upsertUserRow(user)
      addAudit(firm.id, user.id, 'firm', firm.id, 'firm.created', { name: firm.name })
      return createSession(user)
    },
    acceptInvite({ token, firstName, lastName, password }) {
      assertStrongPassword(password)
      const invite = findInviteRowByToken(token)
      if (!invite) throw new Error('Invite not found.')
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
        throw new Error('Invite expired.')
      }
      const existingUser = getUserByEmail(invite.email)
      if (existingUser && existingUser.firmId === invite.firmId)
        throw new Error('Invite email is already associated with an account.')

      const user = {
        id: randomUUID(),
        firmId: invite.firmId,
        email: invite.email,
        passwordHash: hashPassword(password),
        firstName,
        lastName,
        role: invite.role,
        authProvider: 'local',
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        security: { failedLoginCount: 0, lockoutUntil: null, lockedAt: null },
        createdAt: nowIso()
      }

      // users is a source-of-truth table now: targeted upsert (persist() no
      // longer flushes user rows).
      upsertUserRow(user)
      // invites is a source-of-truth table now: accepting removes the row by id.
      deleteInviteRow(invite.id)
      addAudit(invite.firmId, user.id, 'invite', invite.id, 'invite.accepted', { email: invite.email, role: invite.role })
      persist()
      return createSession(user)
    },
    requestReset({ email, ipAddress }) {
      const normalizedEmail = normalizeEmail(email)
      ensureResetRateLimit(normalizedEmail, ipAddress)
      const user = getUserByEmail(normalizedEmail)
      if (!user) {
        // The rate-limit attempt was already recorded durably in
        // password_reset_attempts; nothing else to persist.
        return { ok: true }
      }
      // passwordResets is relational with one active token per user: delete any
      // existing rows for the user, then insert the new token (relational
      // writes are durable, so no persist() is needed).
      deletePasswordResetsByUser(user.id)
      const reset = {
        id: randomUUID(),
        userId: user.id,
        token: randomUUID(),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString()
      }
      insertPasswordReset(reset, { pruneCutoff: nowIso() })
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.requested', {
        ipAddress: sanitizeIp(ipAddress)
      })
      return reset
    },
    resetPassword({ token, password }) {
      assertStrongPassword(password)
      const reset = findPasswordResetByToken(token)
      if (!reset) throw new Error('Reset token not found.')
      if (new Date(reset.expiresAt).getTime() <= Date.now()) {
        // Expired token: consume the relational row and reject (durable delete,
        // no user mutation, so no persist()).
        deletePasswordResetById(reset.id)
        throw new Error('Reset token expired.')
      }
      const user = getUserRow(reset.userId)
      if (!user) throw new Error('User not found.')
      user.passwordHash = hashPassword(password)
      user.security ||= {}
      user.security.failedLoginCount = 0
      user.security.lockoutUntil = null
      user.security.lockedAt = null
      // New password hash + reset security counters are in-place user mutations:
      // upsert them (persist() no longer flushes user rows).
      upsertUserRow(user)
      // Consume every reset token and pending MFA challenge for the user (both
      // relational sources of truth). This cross-table cleanup replaces the old
      // blob-array filters.
      deletePasswordResetsByUser(user.id)
      deleteMfaChallengesByUser(user.id)
      const revokedSessions = revokeUserSessions(user.id)
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.completed', { revokedSessions })
      persist()
      return { ok: true, revokedSessions }
    },
    startTotpEnrollment(user) {
      const actor = getUserRow(user.id)
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
      const actor = getUserRow(user.id)
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
      // Enabling MFA (totpSecret + backup codes) is an in-place user mutation:
      // upsert it. persist() still flushes the mfaEnrollments blob array.
      upsertUserRow(actor)
      state.mfaEnrollments = state.mfaEnrollments.filter((entry) => entry.id !== enrollment.id)
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.enabled', { method: 'totp' })
      persist()
      return { ok: true, backupCodes: plainCodes }
    },
    createMfaChallenge(user) {
      const actor = getUserRow(user.id)
      if (!actor) throw new Error('User not found.')
      const challenge = createAndPersistMfaChallenge(actor.id)
      return { challengeToken: challenge.token, methods: ['totp', 'backup_code'] }
    },
    verifyMfaChallenge(user, { challengeToken, totpCode, backupCode }) {
      const actor = getUserRow(user.id)
      if (!actor) throw new Error('User not found.')
      const mfa = ensureMfaData(actor)
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.')
      const challenge = findMfaChallengeByTokenAndUser(challengeToken, actor.id)
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now())
        throw new Error('MFA challenge expired or not found.')
      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false
      const backupValid = backupCode ? consumeBackupCode(actor, backupCode) : false
      if (!totpValid && !backupValid) {
        throw new Error('Invalid MFA verification code.')
      }
      // mfaChallenges is relational: consume the challenge by id.
      deleteMfaChallengeById(challenge.id)
      // A consumed backup code (splice) is an in-place user mutation: upsert it.
      upsertUserRow(actor)
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.challenge_verified', {
        after: { challengeId: challenge.id }
      })
      return { ok: true }
    },
    rotateBackupCodes(user) {
      const actor = getUserRow(user.id)
      if (!actor) throw new Error('User not found.')
      const mfa = ensureMfaData(actor)
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.')
      const { plainCodes, hashedCodes } = createBackupCodes()
      mfa.backupCodes = hashedCodes
      // Rotated backup codes are an in-place user mutation: upsert them.
      upsertUserRow(actor)
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
