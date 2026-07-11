// audit_events becomes the append-only source of truth. Historically the
// table was a derived projection, destructively resynced from the blob's
// auditEvents array on every saveState. From this version on the store
// inserts canonical events directly and the blob serializes auditEvents: []
// for shape compatibility only.
//
// This migration copies any remaining blob auditEvents into the table
// (id-keyed INSERT OR IGNORE — on most databases the rows already exist from
// the old resync) and then clears the array out of the blob with a targeted
// payload update.
//
// Idempotent: INSERT OR IGNORE never duplicates rows and the blob rewrite
// only happens when a non-empty auditEvents array is present.
import { randomUUID } from 'node:crypto'

export default {
  version: 4,
  name: 'audit-events-source-of-truth',
  up(db) {
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
    const events = Array.isArray(parsed?.auditEvents) ? parsed.auditEvents : []
    if (events.length === 0) return

    const insert = db.prepare(`
      INSERT OR IGNORE INTO audit_events (id, firm_id, action, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const event of events) {
      if (!event || typeof event !== 'object') continue
      insert.run(
        event.id || randomUUID(),
        // firm_id is NOT NULL; unattributed events bucket under 'system'.
        event.firmId ?? 'system',
        event.action || 'unknown',
        event.timestamp || event.occurredAt || new Date().toISOString(),
        JSON.stringify(event)
      )
    }

    parsed.auditEvents = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
