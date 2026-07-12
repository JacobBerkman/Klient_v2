// Marketing events and per-profile meetings become first-class relational
// entities. Greenfield: no prior release stored either anywhere (neither a
// table nor a blob array), so this migration only creates the two
// source-of-truth tables and their read indexes — there is nothing to
// backfill or strip out of the app_state blob.
//
// Both tables follow the established source-of-truth pattern (compare
// 006-board-entities / 011-notifications): promoted scalar columns for the
// fields scoped reads filter/order by, plus a payload JSON column carrying the
// byte-exact canonical object the store wrote.
//
// events: firm-scoped marketing events (seminars/dinners at venues) where
// prospects are acquired. profiles reference an event via
// source.eventId. archived_at NULL means active; a timestamp is the soft-delete
// marker (archivedAt soft pattern, consistent with profiles/households — no
// hard delete). Indexed on (firm_id, event_date) for the firm-scoped,
// date-ordered listing.
//
// meetings: lightweight per-profile meeting log (intro/proposal/review/other).
// profile_id is the subject; created_by is the advisor who logged it. Meetings
// are hard-deleted (the store exposes list/create/delete only), so no
// archived_at column. Two indexes match the read paths: (firm_id, profile_id)
// for the profile-detail list and (firm_id, scheduled_at) for the dashboard's
// upcoming-meetings window.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS, no data mutation.

export default {
  version: 14,
  name: 'events-and-meetings-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    venue TEXT,
    city TEXT,
    event_date TEXT,
    archived_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_firm_date ON events (firm_id, event_date);

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    meeting_type TEXT,
    scheduled_at TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_firm_profile ON meetings (firm_id, profile_id);
  CREATE INDEX IF NOT EXISTS idx_meetings_firm_scheduled ON meetings (firm_id, scheduled_at);
`)
  }
}
