import { createHmac, createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertStrongPassword } from './password-policy.mjs';

const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 5;
const RESET_TTL_MS = 1000 * 60 * 30;
const RESET_RATE_WINDOW_MS = 1000 * 60 * 60;
const MAX_RESETS_PER_USER = 5;
const MAX_RESETS_PER_IP = 10;
const MFA_CHALLENGE_TTL_MS = 1000 * 60 * 10;
const MFA_ENROLL_TTL_MS = 1000 * 60 * 10;
const BACKUP_CODE_COUNT = 8;

function nowIso() {
  return new Date().toISOString();
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex');
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(input || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = '';
  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 input.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function randomBase32(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let output = '';
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

function computeTotp(secret, timeStep = Math.floor(Date.now() / 30000), digits = 6) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function verifyTotpCode(secret, code, window = 1) {
  const normalizedCode = String(code || '').trim();
  const step = Math.floor(Date.now() / 30000);
  for (let drift = -window; drift <= window; drift += 1) {
    if (computeTotp(secret, step + drift) === normalizedCode) return true;
  }
  return false;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sanitizeIp(ipAddress) {
  return String(ipAddress || 'unknown').slice(0, 128);
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase();
}

function pruneByAge(records, maxAgeMs, dateField = 'createdAt') {
  return records.filter((entry) => Date.now() - new Date(entry[dateField]).getTime() <= maxAgeMs);
}

export function createLocalAuthProvider({ state, persist, createSession, addAudit }) {
  function recordLoginAttempt(email, ok) {
    const normalizedEmail = normalizeEmail(email);
    const entry = { id: randomUUID(), email: normalizedEmail, ok, createdAt: nowIso() };
    state.authAttempts = pruneByAge(state.authAttempts || [], LOGIN_WINDOW_MS);
    state.authAttempts.push(entry);
    persist();
  }

  function ensureLoginAllowed(email) {
    const normalizedEmail = normalizeEmail(email);
    const attempts = pruneByAge(state.authAttempts || [], LOGIN_WINDOW_MS)
      .filter((attempt) => attempt.email === normalizedEmail && !attempt.ok);
    if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
      throw new Error('Too many failed login attempts. Please wait 15 minutes and try again.');
    }
  }

  function ensureResetRateLimit(email, ipAddress) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedIp = sanitizeIp(ipAddress);
    state.passwordResetAttempts = pruneByAge(state.passwordResetAttempts || [], RESET_RATE_WINDOW_MS);
    const byUser = state.passwordResetAttempts.filter((attempt) => attempt.email === normalizedEmail);
    const byIp = state.passwordResetAttempts.filter((attempt) => attempt.ipAddress === normalizedIp);
    if (byUser.length >= MAX_RESETS_PER_USER) throw new Error('Too many password reset requests for this user.');
    if (byIp.length >= MAX_RESETS_PER_IP) throw new Error('Too many password reset requests from this IP.');
    state.passwordResetAttempts.push({ id: randomUUID(), email: normalizedEmail, ipAddress: normalizedIp, createdAt: nowIso() });
  }

  function ensureMfaData(user) {
    user.mfa ||= { enabled: false, totpSecret: null, backupCodes: [] };
    user.mfa.backupCodes ||= [];
    return user.mfa;
  }

  function createBackupCodes() {
    const plainCodes = [];
    const hashedCodes = [];
    for (let idx = 0; idx < BACKUP_CODE_COUNT; idx += 1) {
      const code = randomBytes(4).toString('hex').toUpperCase();
      plainCodes.push(code);
      hashedCodes.push(hash(code));
    }
    return { plainCodes, hashedCodes };
  }

  function consumeBackupCode(user, backupCode) {
    const mfa = ensureMfaData(user);
    const lookup = hash(String(backupCode || '').trim().toUpperCase());
    const index = mfa.backupCodes.findIndex((entry) => entry === lookup);
    if (index === -1) return false;
    mfa.backupCodes.splice(index, 1);
    return true;
  }

  function createAndPersistMfaChallenge(userId, method = 'totp') {
    state.mfaChallenges = pruneByAge(state.mfaChallenges || [], MFA_CHALLENGE_TTL_MS);
    const challenge = {
      id: randomUUID(),
      token: randomUUID(),
      userId,
      method,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString()
    };
    state.mfaChallenges.push(challenge);
    persist();
    return challenge;
  }

  return {
    authenticate({ email, password, mfaChallengeToken, totpCode, backupCode }) {
      const normalizedEmail = normalizeEmail(email);
      ensureLoginAllowed(normalizedEmail);
      const user = state.users.find((entry) => entry.email === normalizedEmail && entry.passwordHash === hash(password));
      if (!user) {
        recordLoginAttempt(normalizedEmail, false);
        throw new Error('Invalid email or password.');
      }
      recordLoginAttempt(normalizedEmail, true);
      const mfa = ensureMfaData(user);
      if (!mfa.enabled) return createSession(user);

      if (!mfaChallengeToken) {
        const challenge = createAndPersistMfaChallenge(user.id);
        return { mfaRequired: true, challengeToken: challenge.token, methods: ['totp', 'backup_code'] };
      }

      const challenge = state.mfaChallenges.find((entry) => entry.token === mfaChallengeToken && entry.userId === user.id);
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) {
        throw new Error('MFA challenge expired or not found.');
      }

      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false;
      const backupValid = backupCode ? consumeBackupCode(user, backupCode) : false;
      if (!totpValid && !backupValid) {
        persist();
        throw new Error('Invalid MFA verification code.');
      }

      state.mfaChallenges = state.mfaChallenges.filter((entry) => entry.id !== challenge.id);
      persist();
      return createSession(user);
    },
    register({ firmName, firstName, lastName, email, password }) {
      assertStrongPassword(password);
      const normalizedEmail = normalizeEmail(email);
      if (state.users.some((user) => user.email === normalizedEmail)) throw new Error('An account with this email already exists.');
      const firm = { id: randomUUID(), name: firmName, slug: slugify(firmName), createdAt: nowIso() };
      const user = {
        id: randomUUID(),
        firmId: firm.id,
        email: normalizedEmail,
        passwordHash: hash(password),
        firstName,
        lastName,
        role: 'admin',
        mfa: { enabled: false, totpSecret: null, backupCodes: [] },
        createdAt: nowIso()
      };
      state.firms.push(firm);
      state.users.push(user);
      addAudit(firm.id, user.id, 'firm', firm.id, 'firm.created', { name: firm.name });
      return createSession(user);
    },
    requestReset({ email, ipAddress }) {
      const normalizedEmail = normalizeEmail(email);
      ensureResetRateLimit(normalizedEmail, ipAddress);
      const user = state.users.find((entry) => entry.email === normalizedEmail);
      if (!user) {
        persist();
        return { ok: true };
      }
      state.passwordResets = (state.passwordResets || []).filter((entry) => entry.userId !== user.id);
      const reset = {
        id: randomUUID(),
        userId: user.id,
        token: randomUUID(),
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString()
      };
      state.passwordResets.push(reset);
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.requested', { ipAddress: sanitizeIp(ipAddress) });
      persist();
      return reset;
    },
    resetPassword({ token, password }) {
      assertStrongPassword(password);
      const reset = state.passwordResets.find((entry) => entry.token === token);
      if (!reset) throw new Error('Reset token not found.');
      if (new Date(reset.expiresAt).getTime() <= Date.now()) {
        state.passwordResets = state.passwordResets.filter((entry) => entry.id !== reset.id);
        persist();
        throw new Error('Reset token expired.');
      }
      const user = state.users.find((entry) => entry.id === reset.userId);
      if (!user) throw new Error('User not found.');
      user.passwordHash = hash(password);
      state.passwordResets = state.passwordResets.filter((entry) => entry.userId !== user.id);
      addAudit(user.firmId, user.id, 'user', user.id, 'auth.password_reset.completed', {});
      persist();
      return { ok: true };
    },
    startTotpEnrollment(user) {
      const actor = state.users.find((entry) => entry.id === user.id);
      if (!actor) throw new Error('User not found.');
      const secret = randomBase32(32);
      const enrollment = {
        id: randomUUID(),
        token: randomUUID(),
        userId: actor.id,
        secret,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + MFA_ENROLL_TTL_MS).toISOString()
      };
      state.mfaEnrollments = pruneByAge(state.mfaEnrollments || [], MFA_ENROLL_TTL_MS);
      state.mfaEnrollments.push(enrollment);
      persist();
      const issuer = encodeURIComponent('Klient');
      const label = encodeURIComponent(actor.email);
      return {
        enrollmentToken: enrollment.token,
        secret,
        otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`
      };
    },
    confirmTotpEnrollment(user, { enrollmentToken, code }) {
      const actor = state.users.find((entry) => entry.id === user.id);
      if (!actor) throw new Error('User not found.');
      const enrollment = (state.mfaEnrollments || []).find((entry) => entry.token === enrollmentToken && entry.userId === actor.id);
      if (!enrollment || new Date(enrollment.expiresAt).getTime() <= Date.now()) {
        throw new Error('MFA enrollment challenge expired or not found.');
      }
      if (!verifyTotpCode(enrollment.secret, code)) throw new Error('Invalid MFA verification code.');
      const mfa = ensureMfaData(actor);
      const { plainCodes, hashedCodes } = createBackupCodes();
      mfa.enabled = true;
      mfa.totpSecret = enrollment.secret;
      mfa.backupCodes = hashedCodes;
      state.mfaEnrollments = state.mfaEnrollments.filter((entry) => entry.id !== enrollment.id);
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.enabled', { method: 'totp' });
      persist();
      return { ok: true, backupCodes: plainCodes };
    },
    createMfaChallenge(user) {
      const actor = state.users.find((entry) => entry.id === user.id);
      if (!actor) throw new Error('User not found.');
      const challenge = createAndPersistMfaChallenge(actor.id);
      return { challengeToken: challenge.token, methods: ['totp', 'backup_code'] };
    },
    verifyMfaChallenge(user, { challengeToken, totpCode, backupCode }) {
      const actor = state.users.find((entry) => entry.id === user.id);
      if (!actor) throw new Error('User not found.');
      const mfa = ensureMfaData(actor);
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.');
      const challenge = (state.mfaChallenges || []).find((entry) => entry.token === challengeToken && entry.userId === actor.id);
      if (!challenge || new Date(challenge.expiresAt).getTime() <= Date.now()) throw new Error('MFA challenge expired or not found.');
      const totpValid = totpCode ? verifyTotpCode(mfa.totpSecret, totpCode) : false;
      const backupValid = backupCode ? consumeBackupCode(actor, backupCode) : false;
      if (!totpValid && !backupValid) {
        persist();
        throw new Error('Invalid MFA verification code.');
      }
      state.mfaChallenges = state.mfaChallenges.filter((entry) => entry.id !== challenge.id);
      persist();
      return { ok: true };
    },
    rotateBackupCodes(user) {
      const actor = state.users.find((entry) => entry.id === user.id);
      if (!actor) throw new Error('User not found.');
      const mfa = ensureMfaData(actor);
      if (!mfa.enabled) throw new Error('MFA is not enabled for this account.');
      const { plainCodes, hashedCodes } = createBackupCodes();
      mfa.backupCodes = hashedCodes;
      addAudit(actor.firmId, actor.id, 'user', actor.id, 'auth.mfa.backup_codes_rotated', {});
      persist();
      return { backupCodes: plainCodes };
    }
  };
}

export const __testUtils = {
  computeTotp,
  verifyTotpCode
};
