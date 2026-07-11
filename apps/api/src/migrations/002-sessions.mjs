// Sessions move out of the app_state blob into a relational table so the
// per-request activity touch can be a single-row UPDATE instead of a full
// blob rewrite. This migration creates the table and backfills it from the
// blob's sessions array when one exists.
//
// Idempotency: CREATE TABLE IF NOT EXISTS plus a "only backfill into an empty
// table" guard, so re-running up() (e.g. on a pre-versioned database that is
// stamped later) never duplicates or resurrects rows.
//
// The backfill normalizes sparse legacy records exactly like the store used
// to at startup (see normalizeSessionRecord below): the table is now the only
// source of truth for sessions, and rows with NULL expiry columns would be
// treated as already-expired by deleteExpiredSessions.
import { normalizeSessionRecord } from './session-normalization.mjs'

export default {
  version: 2,
  name: 'sessions-table',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT,
    firm_id TEXT,
    created_at TEXT,
    last_activity_at TEXT,
    expires_at TEXT,
    idle_expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`)

    const existing = db.prepare('SELECT COUNT(*) AS count FROM sessions').get()
    if ((existing?.count || 0) > 0) return

    let row = null
    try {
      row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
    } catch {
      // app_state does not exist yet (unusual bootstrap order); nothing to backfill.
      return
    }
    if (!row?.payload) return

    let sessions = []
    try {
      const parsed = JSON.parse(row.payload)
      sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : []
    } catch {
      // Malformed blob: leave the table empty rather than failing the migration.
      return
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO sessions (token, user_id, firm_id, created_at, last_activity_at, expires_at, idle_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const session of sessions) {
      if (!session || typeof session.token !== 'string' || !session.token) continue
      const normalized = normalizeSessionRecord(session)
      insert.run(
        normalized.token,
        normalized.userId,
        normalized.firmId,
        normalized.createdAt,
        normalized.lastActivityAt,
        normalized.expiresAt,
        normalized.idleExpiresAt
      )
    }
  }
}
