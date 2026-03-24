import { createHash, randomUUID } from 'node:crypto';

const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 5;

function nowIso() {
  return new Date().toISOString();
}

function hash(password) {
  return createHash('sha256').update(password).digest('hex');
}

function assertStrongPassword(password) {
  const value = String(password || '');
  if (value.length < 12) throw new Error('Password must be at least 12 characters long.');
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include uppercase, lowercase, and numeric characters.');
  }
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function createLocalAuthProvider({ state, persist, createSession, addAudit }) {
  function recordLoginAttempt(email, ok) {
    const normalizedEmail = String(email || '').toLowerCase();
    const entry = { id: randomUUID(), email: normalizedEmail, ok, createdAt: nowIso() };
    state.authAttempts = (state.authAttempts || []).filter((attempt) => Date.now() - new Date(attempt.createdAt).getTime() <= LOGIN_WINDOW_MS);
    state.authAttempts.push(entry);
    persist();
  }

  function ensureLoginAllowed(email) {
    const normalizedEmail = String(email || '').toLowerCase();
    const attempts = (state.authAttempts || []).filter((attempt) => attempt.email === normalizedEmail && !attempt.ok && Date.now() - new Date(attempt.createdAt).getTime() <= LOGIN_WINDOW_MS);
    if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
      throw new Error('Too many failed login attempts. Please wait 15 minutes and try again.');
    }
  }

  return {
    authenticate({ email, password }) {
      const normalizedEmail = String(email || '').toLowerCase();
      ensureLoginAllowed(normalizedEmail);
      const user = state.users.find((entry) => entry.email === normalizedEmail && entry.passwordHash === hash(password));
      if (!user) {
        recordLoginAttempt(normalizedEmail, false);
        throw new Error('Invalid email or password.');
      }
      recordLoginAttempt(normalizedEmail, true);
      return createSession(user);
    },
    register({ firmName, firstName, lastName, email, password }) {
      assertStrongPassword(password);
      const normalizedEmail = String(email || '').toLowerCase();
      if (state.users.some((user) => user.email === normalizedEmail)) throw new Error('An account with this email already exists.');
      const firm = { id: randomUUID(), name: firmName, slug: slugify(firmName), createdAt: nowIso() };
      const user = { id: randomUUID(), firmId: firm.id, email: normalizedEmail, passwordHash: hash(password), firstName, lastName, role: 'admin', createdAt: nowIso() };
      state.firms.push(firm);
      state.users.push(user);
      addAudit(firm.id, user.id, 'firm', firm.id, 'firm.created', { name: firm.name });
      return createSession(user);
    },
    requestReset({ email }) {
      const normalizedEmail = String(email || '').toLowerCase();
      const user = state.users.find((entry) => entry.email === normalizedEmail);
      if (!user) return { ok: true };
      const reset = { id: randomUUID(), userId: user.id, token: randomUUID(), createdAt: nowIso() };
      state.passwordResets.push(reset);
      persist();
      return reset;
    },
    resetPassword({ token, password }) {
      assertStrongPassword(password);
      const reset = state.passwordResets.find((entry) => entry.token === token);
      if (!reset) throw new Error('Reset token not found.');
      const user = state.users.find((entry) => entry.id === reset.userId);
      if (!user) throw new Error('User not found.');
      user.passwordHash = hash(password);
      state.passwordResets = state.passwordResets.filter((entry) => entry.id !== reset.id);
      persist();
      return { ok: true };
    }
  };
}
