// In-app notifications become a first-class relational entity. Greenfield: no
// prior release stored notifications anywhere (neither a table nor a blob
// array), so this migration only has to create the source-of-truth table and
// its read indexes — there is nothing to backfill or strip out of the blob.
//
// Table design mirrors the established source-of-truth pattern (compare
// 010-template-entities / the notes + document_uploads repos): promoted scalar
// columns for the fields every scoped read filters/orders by
// (firm_id/user_id/type/read_at/created_at) plus a payload JSON column that
// carries the canonical notification object (title, body, link, entity refs).
//
// user_id is the recipient. A NULL user_id means the notification is firm-wide
// (visible to every member of the firm) — scoped reads select
// (user_id = ? OR user_id IS NULL). read_at NULL means unread; a timestamp
// means read.
//
// Two indexes match the two hot read paths: the unread-count / per-user list
// filters on (firm_id, user_id, read_at); the retention/recent sweep orders on
// (firm_id, created_at).
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS, no data mutation.

export default {
  version: 11,
  name: 'notifications-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    user_id TEXT,
    type TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_firm_user_read
    ON notifications (firm_id, user_id, read_at);

  CREATE INDEX IF NOT EXISTS idx_notifications_firm_created
    ON notifications (firm_id, created_at);
`)
  }
}
