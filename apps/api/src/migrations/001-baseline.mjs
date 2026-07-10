function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

function ensureExportJobsColumns(db) {
  const definitions = [
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
    ['output_payload', 'TEXT'],
    ['error_message', 'TEXT'],
    ['next_attempt_at', 'TEXT'],
    ['leased_by', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['dead_lettered_at', 'TEXT'],
    ['last_attempt_at', 'TEXT'],
    ['idempotency_key', 'TEXT']
  ]
  for (const [column, ddl] of definitions) {
    if (!hasColumn(db, 'export_jobs', column)) {
      db.exec(`ALTER TABLE export_jobs ADD COLUMN ${column} ${ddl}`)
    }
  }
}

function ensureProfilesColumns(db) {
  const definitions = [
    ['email', 'TEXT'],
    ['phone', 'TEXT'],
    ['profile_status', 'TEXT'],
    ['order_index', 'INTEGER'],
    ['source_city', 'TEXT'],
    ['source_venue', 'TEXT'],
    ['source_occurred_on', 'TEXT'],
    ['household_id', 'TEXT'],
    ['spouse_client_id', 'TEXT'],
    ['investable_assets', 'REAL'],
    ['annual_income', 'REAL'],
    ['total_assets', 'REAL'],
    ['total_liabilities', 'REAL'],
    ['net_worth', 'REAL'],
    ['extensions_payload', 'TEXT']
  ]
  for (const [column, ddl] of definitions) {
    if (!hasColumn(db, 'profiles', column)) {
      db.exec(`ALTER TABLE profiles ADD COLUMN ${column} ${ddl}`)
    }
  }
}

// Baseline schema. Existing deployed databases already contain these tables at
// user_version 0, so this migration MUST stay idempotent (IF NOT EXISTS plus
// PRAGMA table_info column guards): it runs once on old databases and simply
// stamps user_version 1.
export default {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    profile_status TEXT,
    stage TEXT,
    stage_order_index INTEGER,
    source_city TEXT,
    source_venue TEXT,
    source_occurred_on TEXT,
    household_id TEXT,
    spouse_client_id TEXT,
    investable_assets REAL,
    annual_income REAL,
    total_assets REAL,
    total_liabilities REAL,
    net_worth REAL,
    extensions_payload TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS form_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_aggregates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    publish_state TEXT,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    payload TEXT NOT NULL,
    output_payload TEXT,
    error_message TEXT,
    next_attempt_at TEXT,
    leased_by TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    dead_lettered_at TEXT,
    last_attempt_at TEXT,
    idempotency_key TEXT
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    action TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_materialized (
    firm_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS csrf_tokens (
    id TEXT PRIMARY KEY,
    session_token TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_rotated_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS export_worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL,
    mode TEXT,
    payload TEXT NOT NULL
  );

`)

    ensureExportJobsColumns(db)
    ensureProfilesColumns(db)
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_export_jobs_firm_idempotency ON export_jobs (firm_id, idempotency_key) WHERE idempotency_key IS NOT NULL'
    )
  }
}
