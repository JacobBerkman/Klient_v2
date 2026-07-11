// The sessions table is now the sole source of truth: session reads moved off
// the in-memory state.sessions mirror, and saveState serializes sessions: []
// for blob-shape compatibility. This migration finishes the cutover for
// databases that already ran migration 002:
//
// 1. Normalizes session rows whose expiry columns are still NULL (the original
//    002 backfill copied raw blob values; the store used to fill defaults in
//    memory at startup, which no longer happens). NULL expiry columns would be
//    treated as already-expired by deleteExpiredSessions, silently logging out
//    legacy sessions.
// 2. Clears the now-retired sessions array out of the app_state blob with a
//    targeted payload update so stale blob sessions can never be resurrected.
//
// Idempotent: the UPDATE only touches NULL columns and the blob rewrite only
// happens when a non-empty sessions array is present.
import { normalizeSessionRecord } from './session-normalization.mjs'

export default {
  version: 3,
  name: 'retire-blob-sessions',
  up(db) {
    const sparseRows = db
      .prepare(
        `
      SELECT token, user_id AS userId, firm_id AS firmId, created_at AS createdAt,
        last_activity_at AS lastActivityAt, expires_at AS expiresAt, idle_expires_at AS idleExpiresAt
      FROM sessions
      WHERE created_at IS NULL OR last_activity_at IS NULL OR expires_at IS NULL OR idle_expires_at IS NULL
    `
      )
      .all()
    const update = db.prepare(
      'UPDATE sessions SET created_at = ?, last_activity_at = ?, expires_at = ?, idle_expires_at = ? WHERE token = ?'
    )
    for (const row of sparseRows) {
      const normalized = normalizeSessionRecord(row)
      update.run(normalized.createdAt, normalized.lastActivityAt, normalized.expiresAt, normalized.idleExpiresAt, row.token)
    }

    let row = null
    try {
      row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
    } catch {
      // app_state does not exist yet; nothing to clean up.
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
    if (!Array.isArray(parsed?.sessions) || parsed.sessions.length === 0) return

    parsed.sessions = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(JSON.stringify(parsed))
  }
}
