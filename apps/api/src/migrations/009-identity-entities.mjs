// The IDENTITY / TENANCY core — firms, users, and households — moves out of the
// app_state blob and becomes the sole source of truth in its own relational
// tables. These three tables already exist from the 001 baseline, but until
// this migration they were DERIVED PROJECTIONS: syncQueryTables destructively
// rebuilt them from the blob arrays on every saveState. From this version on
// the tables are authoritative — written by targeted upserts (upsertFirmRow,
// upsertUserRow, upsertHouseholdRow) — and the blob serializes empty arrays for
// the three keys purely for shape compatibility.
//
// This is the highest-risk cutover of the persistence series: user and firm
// objects carry auth-critical mutable state (failed-login counters, lockout
// windows, MFA secrets, password hashes) that used to ride along the blob
// resync. Every in-place mutation site now upserts explicitly; this migration
// only handles the one-time data move.
//
// Table design reuses the baseline columns exactly (firms: id/name/slug;
// users: id/firm_id/email/role; households: id/firm_id/name) plus the payload
// JSON column that already backed the projection, so the canonical object
// round-trips byte-exact (users' payload carries the MFA totpSecret, backup
// codes, and password hash verbatim). firm stage-config / custom-field-schema
// normalization was already ported into migration 006 (it rewrote the blob
// firms in place), so the arrays this migration backfills are already
// normalized — no re-transform is needed here.
//
// This migration promotes any missing payload column (a no-op on the baseline
// schema, which already has it), backfills the three tables from any remaining
// blob arrays (keyed INSERT OR IGNORE — idempotent against the rows the old
// projection already left behind), and clears the arrays out of the blob with a
// targeted payload update.
//
// Idempotent: CREATE TABLE IF NOT EXISTS, defensive ADD COLUMN guarded by a
// PRAGMA check, keyed INSERT OR IGNORE, and the blob rewrite only happens when
// at least one of the three arrays is non-empty.

function ensurePayloadColumn(db, tableName) {
  // The baseline already declares payload TEXT NOT NULL for all three tables,
  // so this is a no-op there. Guard defensively in case an older hand-built
  // schema is missing it. A NOT NULL column cannot be added to a populated
  // table without a default, so add it as nullable with an empty-object
  // default — the backfill/upserts overwrite it immediately.
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  if (!columns.some((column) => column.name === 'payload')) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'`)
  }
}

export default {
  version: 9,
  name: 'identity-entities-source-of-truth',
  up(db) {
    db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_users_firm ON users (firm_id);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_households_firm ON households (firm_id);
`)

    ensurePayloadColumn(db, 'firms')
    ensurePayloadColumn(db, 'users')
    ensurePayloadColumn(db, 'households')

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

    const firms = Array.isArray(parsed?.firms) ? parsed.firms : []
    const users = Array.isArray(parsed?.users) ? parsed.users : []
    const households = Array.isArray(parsed?.households) ? parsed.households : []
    if (firms.length === 0 && users.length === 0 && households.length === 0) {
      return
    }

    // firms: name/slug promoted; the full firm object (stageConfig,
    // customFieldSchema — already normalized by migration 006) is preserved
    // verbatim in the payload column.
    const insertFirm = db.prepare(`
      INSERT OR IGNORE INTO firms (id, name, slug, payload)
      VALUES (?, ?, ?, ?)
    `)
    for (const firm of firms) {
      if (!firm || typeof firm !== 'object' || !firm.id) continue
      insertFirm.run(firm.id, firm.name ?? '', firm.slug ?? '', JSON.stringify(firm))
    }

    // users: firm_id/email/role promoted; the full user object (passwordHash,
    // mfa.totpSecret, mfa.backupCodes, security counters) is preserved verbatim.
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, firm_id, email, role, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const user of users) {
      if (!user || typeof user !== 'object' || !user.id) continue
      insertUser.run(user.id, user.firmId ?? 'unknown', user.email ?? '', user.role ?? '', JSON.stringify(user))
    }

    const insertHousehold = db.prepare(`
      INSERT OR IGNORE INTO households (id, firm_id, name, payload)
      VALUES (?, ?, ?, ?)
    `)
    for (const household of households) {
      if (!household || typeof household !== 'object' || !household.id) continue
      insertHousehold.run(
        household.id,
        household.firmId ?? 'unknown',
        household.name ?? '',
        JSON.stringify(household)
      )
    }

    parsed.firms = []
    parsed.users = []
    parsed.households = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
