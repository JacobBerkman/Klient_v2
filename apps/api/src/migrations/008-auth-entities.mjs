// The four ephemeral auth entities move out of the app_state blob into
// relational tables as sources of truth:
//   - auth_attempts: the login-attempt log that drives per-email and per-IP
//     login rate limiting.
//   - password_reset_attempts: the reset-request log that drives per-user and
//     per-IP reset rate limiting.
//   - password_resets: outstanding reset tokens (one active row per user).
//   - mfa_challenges: pending MFA login challenges.
//
// These are SECURITY-CRITICAL: login lockout, reset throttling, reset-token
// TTL, and MFA-challenge TTL are all enforced by SQL COUNT-with-cutoff and
// expiry comparisons against these tables from this version on. The blob
// serializes empty arrays for the four keys purely for shape compatibility.
//
// Table design: columns-only (no payload JSON). Each record is small, flat,
// and fully described by its columns — there is no nested structure to
// round-trip, unlike submissions/notes/uploads which carry encrypted envelopes
// or object metadata. Promoted columns are exactly the query keys: (email,
// created_at) and (ip_address, created_at) for the attempt-count windows,
// user_id for reset/challenge revocation, and token for single-token lookups.
//
// This migration creates the tables, backfills them from any remaining blob
// arrays (keyed INSERT OR IGNORE — idempotent), and clears the four arrays out
// of the blob with a targeted payload update. These records are ephemeral, so
// the backfill is best-effort (rows that fail a NOT NULL / UNIQUE guard are
// simply dropped rather than failing the migration).
//
// Idempotent: CREATE TABLE IF NOT EXISTS, keyed INSERT OR IGNORE, and the blob
// rewrite only happens when at least one of the four arrays is non-empty.
import { randomUUID } from 'node:crypto'

export default {
  version: 8,
  name: 'auth-entities-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS auth_attempts (
    id TEXT PRIMARY KEY,
    email TEXT,
    ip_address TEXT,
    ok INTEGER,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_auth_attempts_email ON auth_attempts (email, created_at);
  CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip ON auth_attempts (ip_address, created_at);

  CREATE TABLE IF NOT EXISTS password_reset_attempts (
    id TEXT PRIMARY KEY,
    email TEXT,
    ip_address TEXT,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_password_reset_attempts_email ON password_reset_attempts (email, created_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_attempts_ip ON password_reset_attempts (ip_address, created_at);

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT,
    expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);

  CREATE TABLE IF NOT EXISTS mfa_challenges (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    user_id TEXT,
    method TEXT,
    created_at TEXT,
    expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges (user_id);
  CREATE INDEX IF NOT EXISTS idx_mfa_challenges_token ON mfa_challenges (token);
`)

    let row = null
    try {
      row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
    } catch {
      // app_state does not exist yet (fresh database); nothing to backfill.
      return
    }
    if (!row?.payload) return

    let parsed = null
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      // Malformed blob: leave it untouched rather than failing the migration.
      return
    }

    const authAttempts = Array.isArray(parsed?.authAttempts) ? parsed.authAttempts : []
    const passwordResetAttempts = Array.isArray(parsed?.passwordResetAttempts) ? parsed.passwordResetAttempts : []
    const passwordResets = Array.isArray(parsed?.passwordResets) ? parsed.passwordResets : []
    const mfaChallenges = Array.isArray(parsed?.mfaChallenges) ? parsed.mfaChallenges : []
    if (
      authAttempts.length === 0 &&
      passwordResetAttempts.length === 0 &&
      passwordResets.length === 0 &&
      mfaChallenges.length === 0
    ) {
      return
    }

    const insertAuthAttempt = db.prepare(`
      INSERT OR IGNORE INTO auth_attempts (id, email, ip_address, ok, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const attempt of authAttempts) {
      if (!attempt || typeof attempt !== 'object') continue
      insertAuthAttempt.run(
        attempt.id || randomUUID(),
        attempt.email ?? null,
        attempt.ipAddress ?? null,
        attempt.ok ? 1 : 0,
        attempt.createdAt ?? null
      )
    }

    const insertResetAttempt = db.prepare(`
      INSERT OR IGNORE INTO password_reset_attempts (id, email, ip_address, created_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const attempt of passwordResetAttempts) {
      if (!attempt || typeof attempt !== 'object') continue
      insertResetAttempt.run(
        attempt.id || randomUUID(),
        attempt.email ?? null,
        attempt.ipAddress ?? null,
        attempt.createdAt ?? null
      )
    }

    const insertReset = db.prepare(`
      INSERT OR IGNORE INTO password_resets (id, user_id, token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const reset of passwordResets) {
      if (!reset || typeof reset !== 'object' || !reset.token) continue
      insertReset.run(
        reset.id || randomUUID(),
        reset.userId ?? null,
        reset.token,
        reset.createdAt ?? null,
        reset.expiresAt ?? null
      )
    }

    const insertChallenge = db.prepare(`
      INSERT OR IGNORE INTO mfa_challenges (id, token, user_id, method, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const challenge of mfaChallenges) {
      if (!challenge || typeof challenge !== 'object' || !challenge.token) continue
      insertChallenge.run(
        challenge.id || randomUUID(),
        challenge.token,
        challenge.userId ?? null,
        challenge.method ?? null,
        challenge.createdAt ?? null,
        challenge.expiresAt ?? null
      )
    }

    parsed.authAttempts = []
    parsed.passwordResetAttempts = []
    parsed.passwordResets = []
    parsed.mfaChallenges = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
