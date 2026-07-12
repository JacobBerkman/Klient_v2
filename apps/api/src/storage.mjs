import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { runMigrations } from './migrations/index.mjs'

export const DB_PATH = resolve(process.cwd(), 'data', 'app.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

// Durability pragmas applied to every connection against the app database.
// journal_mode = WAL is persistent, but re-issuing it is harmless; busy_timeout
// and synchronous are per-connection and must be set on each open.
export function applyConnectionPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
}

const db = new DatabaseSync(DB_PATH)
applyConnectionPragmas(db)
runMigrations(db)

db.exec(`
  UPDATE export_jobs
  SET
    attempts = COALESCE(attempts, json_extract(payload, '$.attempts'), 0),
    max_attempts = COALESCE(max_attempts, json_extract(payload, '$.maxAttempts'), 3),
    created_at = COALESCE(created_at, json_extract(payload, '$.createdAt'), datetime('now')),
    updated_at = COALESCE(updated_at, json_extract(payload, '$.updatedAt'), datetime('now')),
    next_attempt_at = COALESCE(next_attempt_at, json_extract(payload, '$.nextAttemptAt'), created_at)
`)

db.exec(`
  UPDATE profiles
  SET order_index = COALESCE(order_index, stage_order_index, json_extract(payload, '$.orderIndex'), json_extract(payload, '$.stageOrderIndex'))
`)

function nowIso() {
  return new Date().toISOString()
}

// --- Transaction helper -------------------------------------------------------
// Single shared BEGIN IMMEDIATE wrapper. SQLite does not support nested
// transactions, so nested runInTransaction calls join the outer transaction:
// only the outermost frame issues BEGIN/COMMIT/ROLLBACK. This is what lets
// executePipelineTransaction wrap persist() (whose saveState also runs inside
// runInTransaction) in one atomic unit.
let inTransaction = false

export function runInTransaction(fn) {
  if (inTransaction) {
    return fn()
  }
  db.exec('BEGIN IMMEDIATE')
  inTransaction = true
  try {
    const result = fn()
    db.exec('COMMIT')
    inTransaction = false
    return result
  } catch (error) {
    inTransaction = false
    db.exec('ROLLBACK')
    throw error
  }
}

export function upsertCsrfToken(record) {
  db.prepare(
    `
    INSERT INTO csrf_tokens (id, session_token, user_id, token, issued_at, expires_at, last_rotated_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_token = excluded.session_token,
      user_id = excluded.user_id,
      token = excluded.token,
      issued_at = excluded.issued_at,
      expires_at = excluded.expires_at,
      last_rotated_at = excluded.last_rotated_at,
      consumed_at = excluded.consumed_at
  `
  ).run(
    record.id,
    record.sessionToken,
    record.userId,
    record.token,
    record.issuedAt,
    record.expiresAt,
    record.lastRotatedAt || record.issuedAt,
    record.consumedAt || null
  )
}

export function readCsrfToken(sessionToken, tokenId) {
  const row = db
    .prepare(
      `
    SELECT id, session_token AS sessionToken, user_id AS userId, token, issued_at AS issuedAt,
      expires_at AS expiresAt, last_rotated_at AS lastRotatedAt, consumed_at AS consumedAt
    FROM csrf_tokens
    WHERE session_token = ? AND id = ?
  `
    )
    .get(sessionToken, tokenId)
  return row || null
}

export function consumeCsrfToken(sessionToken, tokenId, consumedAt = nowIso()) {
  const result = db
    .prepare(
      `
      UPDATE csrf_tokens
      SET consumed_at = ?
      WHERE session_token = ? AND id = ? AND consumed_at IS NULL AND expires_at > ?
    `
    )
    .run(consumedAt, sessionToken, tokenId, consumedAt)
  return result.changes > 0
}

export function deleteCsrfToken(tokenId) {
  db.prepare('DELETE FROM csrf_tokens WHERE id = ?').run(tokenId)
}

export function deleteCsrfTokensBySession(sessionToken) {
  db.prepare('DELETE FROM csrf_tokens WHERE session_token = ?').run(sessionToken)
}

export function deleteCsrfTokensByUser(userId) {
  db.prepare('DELETE FROM csrf_tokens WHERE user_id = ?').run(userId)
}

export function deleteExpiredCsrfTokens(cutoffIso = new Date().toISOString()) {
  db.prepare('DELETE FROM csrf_tokens WHERE expires_at <= ?').run(cutoffIso)
}

// --- Session repository (sole source of truth) ------------------------------
// Sessions are the highest-write-volume entity: every authenticated request
// touches lastActivityAt/idleExpiresAt. The sessions table is the only home
// for session records: reads and writes both go through these helpers, and
// the app_state blob serializes an empty sessions array purely for shape
// compatibility.

const SESSION_COLUMNS = `
  token,
  user_id AS userId,
  firm_id AS firmId,
  created_at AS createdAt,
  last_activity_at AS lastActivityAt,
  expires_at AS expiresAt,
  idle_expires_at AS idleExpiresAt
`

export function upsertSession(session) {
  db.prepare(
    `
    INSERT INTO sessions (token, user_id, firm_id, created_at, last_activity_at, expires_at, idle_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      firm_id = excluded.firm_id,
      created_at = excluded.created_at,
      last_activity_at = excluded.last_activity_at,
      expires_at = excluded.expires_at,
      idle_expires_at = excluded.idle_expires_at
  `
  ).run(
    session.token,
    session.userId ?? null,
    session.firmId ?? null,
    session.createdAt ?? null,
    session.lastActivityAt ?? null,
    session.expiresAt ?? null,
    session.idleExpiresAt ?? null
  )
}

// Single-row activity touch: the whole point of the sessions table. Replaces
// the per-request full-state persist() that used to serialize the entire blob.
export function touchSession(token, { lastActivityAt, idleExpiresAt } = {}) {
  const result = db
    .prepare('UPDATE sessions SET last_activity_at = ?, idle_expires_at = ? WHERE token = ?')
    .run(lastActivityAt ?? null, idleExpiresAt ?? null, token)
  return result.changes > 0
}

export function deleteSession(token) {
  const result = db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  return result.changes > 0
}

// Returns the deleted session rows (token, userId, firmId, expiry columns) so
// callers can fire per-session cleanup (CSRF token invalidation,
// session-invalidated callbacks) with the same payload the in-memory prune
// used to provide, including enough data to distinguish idle vs absolute
// expiry.
export function deleteExpiredSessions(nowIsoCutoff = nowIso()) {
  const expired = db
    .prepare(
      `
      SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE expires_at IS NULL OR expires_at <= ?
        OR idle_expires_at IS NULL OR idle_expires_at <= ?
    `
    )
    .all(nowIsoCutoff, nowIsoCutoff)
  if (expired.length) {
    const placeholders = expired.map(() => '?').join(', ')
    db.prepare(`DELETE FROM sessions WHERE token IN (${placeholders})`).run(...expired.map((row) => row.token))
  }
  return expired
}

// Bulk revocation for a single user (password reset). Returns the deleted
// tokens; deliberately does NOT fire per-session callbacks — that matches the
// pre-table behavior where auth providers revoked sessions without invoking
// onSessionInvalidated.
export function deleteSessionsByUser(userId) {
  const tokens = db
    .prepare('SELECT token FROM sessions WHERE user_id = ?')
    .all(userId)
    .map((row) => row.token)
  if (tokens.length) {
    const placeholders = tokens.map(() => '?').join(', ')
    db.prepare(`DELETE FROM sessions WHERE token IN (${placeholders})`).run(...tokens)
  }
  return tokens
}

export function listSessionsFromTable() {
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY created_at ASC`).all()
}

export function getSessionByToken(token) {
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token = ?`).get(token) || null
}

export function listExportQueueJobs() {
  const rows = db
    .prepare(
      `
    SELECT id, firm_id AS firmId, client_id AS clientId, type, status, attempts,
      max_attempts AS maxAttempts, payload, output_payload AS outputPayload,
      error_message AS errorMessage, next_attempt_at AS nextAttemptAt,
      leased_by AS leasedBy, lease_expires_at AS leaseExpiresAt,
      created_at AS createdAt, updated_at AS updatedAt,
      completed_at AS completedAt, dead_lettered_at AS deadLetteredAt,
      last_attempt_at AS lastAttemptAt, idempotency_key AS idempotencyKey
    FROM export_jobs
    ORDER BY created_at DESC
  `
    )
    .all()
  return rows.map((row) => {
    const payload = row.payload ? JSON.parse(row.payload) : {}
    const output = row.outputPayload ? JSON.parse(row.outputPayload) : null
    return {
      ...payload,
      id: row.id,
      firmId: row.firmId,
      clientId: row.clientId,
      type: row.type,
      status: row.status,
      attempts: row.attempts || 0,
      maxAttempts: row.maxAttempts || 3,
      output,
      errorMessage: row.errorMessage || null,
      nextAttemptAt: row.nextAttemptAt || null,
      leasedBy: row.leasedBy || null,
      leaseExpiresAt: row.leaseExpiresAt || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt || null,
      deadLetteredAt: row.deadLetteredAt || null,
      lastAttemptAt: row.lastAttemptAt || null,
      idempotencyKey: row.idempotencyKey || null
    }
  })
}

function ensureQueueSeededFromState(state) {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM export_jobs').get()
  if ((countRow?.count || 0) > 0) return
  const insert = db.prepare(`
    INSERT INTO export_jobs (
      id, firm_id, client_id, type, status, attempts, max_attempts, payload, output_payload,
      error_message, next_attempt_at, leased_by, lease_expires_at, created_at, updated_at,
      completed_at, dead_lettered_at, last_attempt_at, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const job of state.exportJobs || []) {
    const createdAt = job.createdAt || nowIso()
    const updatedAt = job.updatedAt || createdAt
    const completedAt = job.status === 'completed' ? updatedAt : null
    const nextAttemptAt = job.nextAttemptAt || createdAt
    insert.run(
      job.id,
      job.firmId,
      job.clientId || null,
      job.type || 'pdf',
      job.status || 'queued',
      Number(job.attempts || 0),
      Number(job.maxAttempts || 3),
      JSON.stringify(job),
      job.output ? JSON.stringify(job.output) : null,
      job.errorMessage || null,
      nextAttemptAt,
      null,
      null,
      createdAt,
      updatedAt,
      completedAt,
      job.deadLetteredAt || null,
      job.lastAttemptAt || null,
      job.idempotencyKey || null
    )
  }
}

// --- Template repositories (sources of truth) --------------------------------
// The template system — form templates, document (PDF) templates, and the
// unified template aggregates that back the mapper / publish flow — is the LAST
// entity family to leave the app_state blob (migration 010). Until then
// syncQueryTables destructively rebuilt these three tables from the blob arrays
// via replaceRows on every saveState; with the cutover complete both
// syncQueryTables and replaceRows are gone.
//
// template_aggregates is the canonical source: the store hydrates an in-memory
// working set from it at boot (via listTemplateAggregateRows) and upserts the
// row at every mutation site (create, mapping/pdf-layout edits, lifecycle /
// publish transitions, version revert, auto-build linkage). Because these
// tables are no longer flushed by persist(), a missed upsert silently drops
// that mutation — e.g. a published template that reverts to draft on reload.
// form_templates and document_templates are companion projection tables kept in
// sync through the same mutation path (each row's payload is the adapter view of
// its aggregate); the canonical aggregate object round-trips byte-exact through
// the template_aggregates payload column (blueprint, mappings, pdfLayout,
// versions, publishTransitions carried verbatim).

const TEMPLATE_AGGREGATE_UPSERT_SQL = `
  INSERT INTO template_aggregates (id, firm_id, name, kind, publish_state, payload)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    name = excluded.name,
    kind = excluded.kind,
    publish_state = excluded.publish_state,
    payload = excluded.payload
`

export function upsertTemplateAggregateRow(template) {
  db.prepare(TEMPLATE_AGGREGATE_UPSERT_SQL).run(
    template.id,
    template.firmId ?? 'unknown',
    template.name ?? '',
    template.kind || 'document',
    template.publishState || 'draft',
    JSON.stringify(template)
  )
  return template
}

// Unscoped by default: tenancy validation happens in the store via
// validateTenantEntityOwnership so a cross-firm id surfaces the same
// "Template not found." tenancy error the in-memory find produced.
export function getTemplateAggregateRow(templateId, { firmId = null } = {}) {
  if (!templateId) return null
  const row = firmId
    ? db.prepare('SELECT payload FROM template_aggregates WHERE id = ? AND firm_id = ?').get(templateId, firmId)
    : db.prepare('SELECT payload FROM template_aggregates WHERE id = ?').get(templateId)
  return row?.payload ? JSON.parse(row.payload) : null
}

// Insertion order (rowid ASC — the upsert is ON CONFLICT DO UPDATE, which
// preserves rowid) mirrors the old state.templateAggregates push order.
export function listTemplateAggregateRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM template_aggregates WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM template_aggregates ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

export function deleteTemplateAggregateRow(templateId, firmId) {
  const result = db.prepare('DELETE FROM template_aggregates WHERE id = ? AND firm_id = ?').run(templateId, firmId)
  return result.changes > 0
}

const FORM_TEMPLATE_UPSERT_SQL = `
  INSERT INTO form_templates (id, firm_id, name, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    name = excluded.name,
    payload = excluded.payload
`

export function upsertFormTemplateRow(template) {
  db.prepare(FORM_TEMPLATE_UPSERT_SQL).run(
    template.id,
    template.firmId ?? 'unknown',
    template.name ?? '',
    JSON.stringify(template)
  )
  return template
}

export function getFormTemplateRow(templateId, { firmId = null } = {}) {
  if (!templateId) return null
  const row = firmId
    ? db.prepare('SELECT payload FROM form_templates WHERE id = ? AND firm_id = ?').get(templateId, firmId)
    : db.prepare('SELECT payload FROM form_templates WHERE id = ?').get(templateId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function listFormTemplateRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM form_templates WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM form_templates ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

export function deleteFormTemplateRow(templateId, firmId) {
  const result = db.prepare('DELETE FROM form_templates WHERE id = ? AND firm_id = ?').run(templateId, firmId)
  return result.changes > 0
}

const DOCUMENT_TEMPLATE_UPSERT_SQL = `
  INSERT INTO document_templates (id, firm_id, name, status, payload)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    name = excluded.name,
    status = excluded.status,
    payload = excluded.payload
`

export function upsertDocumentTemplateRow(template) {
  db.prepare(DOCUMENT_TEMPLATE_UPSERT_SQL).run(
    template.id,
    template.firmId ?? 'unknown',
    template.name ?? '',
    template.status ?? template.publishState ?? 'draft',
    JSON.stringify(template)
  )
  return template
}

export function getDocumentTemplateRow(templateId, { firmId = null } = {}) {
  if (!templateId) return null
  const row = firmId
    ? db.prepare('SELECT payload FROM document_templates WHERE id = ? AND firm_id = ?').get(templateId, firmId)
    : db.prepare('SELECT payload FROM document_templates WHERE id = ?').get(templateId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function listDocumentTemplateRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM document_templates WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM document_templates ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

export function deleteDocumentTemplateRow(templateId, firmId) {
  const result = db.prepare('DELETE FROM document_templates WHERE id = ? AND firm_id = ?').run(templateId, firmId)
  return result.changes > 0
}

// Blob-to-table seeding for freshly seeded states (whose demo form/document
// templates exist only in memory) and any legacy blob that predates migration
// 010. Keyed INSERT OR IGNORE keeps it idempotent against the migration
// backfill and the rows the old projection already left behind. The store's
// boot-time migrateTemplateSystems then normalizes and re-upserts the canonical
// aggregates (and re-derives the two companion projections).
function ensureTemplateEntitiesSeededFromState(state) {
  const insertAggregate = db.prepare(`
    INSERT OR IGNORE INTO template_aggregates (id, firm_id, name, kind, publish_state, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const template of state.templateAggregates || []) {
    if (!template || typeof template !== 'object' || !template.id) continue
    insertAggregate.run(
      template.id,
      template.firmId ?? 'unknown',
      template.name ?? '',
      template.kind || 'document',
      template.publishState || 'draft',
      JSON.stringify(template)
    )
  }
  const insertForm = db.prepare(`
    INSERT OR IGNORE INTO form_templates (id, firm_id, name, payload)
    VALUES (?, ?, ?, ?)
  `)
  for (const template of state.formTemplates || []) {
    if (!template || typeof template !== 'object' || !template.id) continue
    insertForm.run(template.id, template.firmId ?? 'unknown', template.name ?? '', JSON.stringify(template))
  }
  const insertDocument = db.prepare(`
    INSERT OR IGNORE INTO document_templates (id, firm_id, name, status, payload)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const template of state.documentTemplates || []) {
    if (!template || typeof template !== 'object' || !template.id) continue
    insertDocument.run(
      template.id,
      template.firmId ?? 'unknown',
      template.name ?? '',
      template.status ?? template.publishState ?? 'draft',
      JSON.stringify(template)
    )
  }
}

// --- Identity repositories (sources of truth) --------------------------------
// firms, users, and households are the IDENTITY / TENANCY core. Since migration
// 009 these tables are authoritative: the canonical object lives in the payload
// JSON column (round-tripped byte-exact — a user's payload carries the
// password hash, MFA totpSecret, backup codes, and security counters), and hot
// columns (ids, tenancy, email, role, name, slug) are promoted for keying and
// firm-scoped queries. Every in-place mutation MUST call the matching upsert:
// with these tables removed from syncQueryTables, persist() no longer flushes
// them, so a missed upsert silently drops that mutation (e.g. a failed-login
// counter that never persists → lockout never triggers).

const FIRM_UPSERT_SQL = `
  INSERT INTO firms (id, name, slug, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    slug = excluded.slug,
    payload = excluded.payload
`

export function upsertFirmRow(firm) {
  db.prepare(FIRM_UPSERT_SQL).run(firm.id, firm.name ?? '', firm.slug ?? '', JSON.stringify(firm))
  return firm
}

export function getFirmRow(firmId) {
  if (!firmId) return null
  const row = db.prepare('SELECT payload FROM firms WHERE id = ?').get(firmId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function getFirmBySlug(slug) {
  if (!slug) return null
  const row = db.prepare('SELECT payload FROM firms WHERE slug = ? ORDER BY rowid ASC').get(slug)
  return row?.payload ? JSON.parse(row.payload) : null
}

// Insertion order (rowid ASC — the upsert is ON CONFLICT DO UPDATE, which
// preserves rowid) mirrors the old state.firms push order.
export function listFirmRows() {
  return db
    .prepare('SELECT payload FROM firms ORDER BY rowid ASC')
    .all()
    .map((row) => JSON.parse(row.payload))
}

const USER_UPSERT_SQL = `
  INSERT INTO users (id, firm_id, email, role, payload)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    email = excluded.email,
    role = excluded.role,
    payload = excluded.payload
`

export function upsertUserRow(user) {
  db.prepare(USER_UPSERT_SQL).run(
    user.id,
    user.firmId ?? 'unknown',
    user.email ?? '',
    user.role ?? '',
    JSON.stringify(user)
  )
  return user
}

export function getUserRow(userId) {
  if (!userId) return null
  const row = db.prepare('SELECT payload FROM users WHERE id = ?').get(userId)
  return row?.payload ? JSON.parse(row.payload) : null
}

// Login treats email as globally unique (the local provider authenticates by
// email alone), so this returns the first user with a matching email in
// insertion order. Email is stored already lowercase-normalized by the write
// paths, so callers pass a normalized email.
export function getUserByEmail(email) {
  if (!email) return null
  const row = db.prepare('SELECT payload FROM users WHERE email = ? ORDER BY rowid ASC').get(email)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function listUserRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM users WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM users ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

export function listUsersByFirm(firmId) {
  return listUserRows({ firmId })
}

export function deleteUserRow(userId) {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  return result.changes > 0
}

const HOUSEHOLD_UPSERT_SQL = `
  INSERT INTO households (id, firm_id, name, payload)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    name = excluded.name,
    payload = excluded.payload
`

export function upsertHouseholdRow(household) {
  db.prepare(HOUSEHOLD_UPSERT_SQL).run(
    household.id,
    household.firmId ?? 'unknown',
    household.name ?? '',
    JSON.stringify(household)
  )
  return household
}

// Unscoped by default: tenancy validation happens in the store via
// validateTenantEntityOwnership so a cross-firm id surfaces the same
// "Household not found." tenancy error the in-memory find produced.
export function getHouseholdRow(householdId, { firmId = null } = {}) {
  if (!householdId) return null
  const row = firmId
    ? db.prepare('SELECT payload FROM households WHERE id = ? AND firm_id = ?').get(householdId, firmId)
    : db.prepare('SELECT payload FROM households WHERE id = ?').get(householdId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function listHouseholdRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM households WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM households ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

export function deleteHouseholdRow(householdId, firmId) {
  const result = db.prepare('DELETE FROM households WHERE id = ? AND firm_id = ?').run(householdId, firmId)
  return result.changes > 0
}

// Blob-to-table seeding for freshly seeded states (whose demo firm/admin/
// household exist only in memory) and any legacy blob that predates migration
// 009. Keyed INSERT OR IGNORE keeps it idempotent against the migration
// backfill and the rows the old projection left behind.
function ensureIdentityEntitiesSeededFromState(state) {
  const insertFirm = db.prepare(`
    INSERT OR IGNORE INTO firms (id, name, slug, payload)
    VALUES (?, ?, ?, ?)
  `)
  for (const firm of state.firms || []) {
    if (!firm || typeof firm !== 'object' || !firm.id) continue
    insertFirm.run(firm.id, firm.name ?? '', firm.slug ?? '', JSON.stringify(firm))
  }
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, firm_id, email, role, payload)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const user of state.users || []) {
    if (!user || typeof user !== 'object' || !user.id) continue
    insertUser.run(user.id, user.firmId ?? 'unknown', user.email ?? '', user.role ?? '', JSON.stringify(user))
  }
  const insertHousehold = db.prepare(`
    INSERT OR IGNORE INTO households (id, firm_id, name, payload)
    VALUES (?, ?, ?, ?)
  `)
  for (const household of state.households || []) {
    if (!household || typeof household !== 'object' || !household.id) continue
    insertHousehold.run(
      household.id,
      household.firmId ?? 'unknown',
      household.name ?? '',
      JSON.stringify(household)
    )
  }
}

// --- Audit repository (append-only source of truth) --------------------------
// Canonical audit events are inserted directly into audit_events; the blob
// serializes auditEvents: [] purely for shape compatibility. The full
// canonical event lives in the payload JSON column; id/firm_id/action/
// occurred_at are promoted for keying, tenancy scoping, and ordering.

export function insertAuditEvent(event) {
  if (!event || typeof event !== 'object') return false
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO audit_events (id, firm_id, action, occurred_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(
      event.id || randomUUID(),
      // firm_id is NOT NULL; system-level events (no firm attribution) are
      // bucketed under 'system' and never match a real firm's scoped reads.
      event.firmId ?? 'system',
      event.action || 'unknown',
      event.timestamp || event.occurredAt || nowIso(),
      JSON.stringify(event)
    )
  return result.changes > 0
}

// Firm-scoped, newest-first. rowid DESC breaks same-timestamp ties in reverse
// insertion order, matching the old in-memory push+reverse read exactly.
export function listAuditEvents(firmId, { limit = 0 } = {}) {
  const baseSql = `
    SELECT payload FROM audit_events
    WHERE firm_id = ?
    ORDER BY occurred_at DESC, rowid DESC
  `
  const rows =
    Number(limit) > 0
      ? db.prepare(`${baseSql} LIMIT ?`).all(firmId, Number(limit))
      : db.prepare(baseSql).all(firmId)
  return rows.map((row) => JSON.parse(row.payload))
}

export function countAuditEvents() {
  return db.prepare('SELECT COUNT(*) AS count FROM audit_events').get()?.count || 0
}

// Blob-to-table audit seeding: id-keyed INSERT OR IGNORE, so it is idempotent
// against the migration 004 backfill and safe to run on the freshly seeded
// state (whose seed audit events exist only in memory).
function ensureAuditSeededFromState(state) {
  for (const event of state.auditEvents || []) {
    insertAuditEvent(event)
  }
}

// --- Form submission repository (source of truth) ----------------------------
// The canonical submission object (data, draft lock, collaborators, revision)
// lives in the payload JSON column; id/firm_id/client_id/template_id/status/
// source/created_by_user_id and the timestamps are promoted for keying,
// tenancy scoping, and filtered queries. Reads return JSON.parse(payload) so
// the object shape is exactly what the store wrote — the blob serializes
// formSubmissions: [] purely for shape compatibility.
//
// Ordering: rowid ASC mirrors the old in-memory push order, so list readers
// that used to iterate state.formSubmissions see the same sequence.

const SUBMISSION_UPSERT_SQL = `
  INSERT INTO form_submissions (
    id, firm_id, client_id, template_id, status, source, created_by_user_id, created_at, updated_at, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    client_id = excluded.client_id,
    template_id = excluded.template_id,
    status = excluded.status,
    source = excluded.source,
    created_by_user_id = excluded.created_by_user_id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    payload = excluded.payload
`

function submissionParams(submission) {
  return [
    submission.id,
    submission.firmId ?? 'unknown',
    submission.clientId ?? null,
    submission.templateId ?? null,
    submission.status ?? null,
    submission.source ?? null,
    submission.createdByUserId ?? null,
    submission.createdAt ?? null,
    submission.updatedAt ?? submission.createdAt ?? null,
    JSON.stringify(submission)
  ]
}

export function upsertFormSubmission(submission) {
  db.prepare(SUBMISSION_UPSERT_SQL).run(...submissionParams(submission))
  return submission
}

// Optimistic-concurrency write for draft revisions: the row only updates when
// the stored revisionId still equals the revision the caller loaded AND the
// stored lock lease still matches the lease the caller validated. A missing
// revisionId counts as 1 (matching the store's Number(revisionId || 1)); a
// missing lock lease counts as ''. Returns false when another writer moved
// the draft first — the caller re-reads and surfaces the same
// revision-conflict contract the API has always exposed.
export function updateFormSubmissionGuarded(submission, { expectedRevisionId, expectedLockLeaseId } = {}) {
  const result = db
    .prepare(
      `
      UPDATE form_submissions
      SET client_id = ?, template_id = ?, status = ?, source = ?, created_by_user_id = ?,
        created_at = ?, updated_at = ?, payload = ?
      WHERE id = ? AND firm_id = ?
        AND (? IS NULL OR CAST(COALESCE(json_extract(payload, '$.revisionId'), 1) AS INTEGER) = ?)
        AND (? IS NULL OR COALESCE(json_extract(payload, '$.lock.leaseId'), '') = ?)
    `
    )
    .run(
      submission.clientId ?? null,
      submission.templateId ?? null,
      submission.status ?? null,
      submission.source ?? null,
      submission.createdByUserId ?? null,
      submission.createdAt ?? null,
      submission.updatedAt ?? submission.createdAt ?? null,
      JSON.stringify(submission),
      submission.id,
      submission.firmId ?? 'unknown',
      expectedRevisionId ?? null,
      expectedRevisionId ?? null,
      expectedLockLeaseId ?? null,
      expectedLockLeaseId ?? null
    )
  return result.changes > 0
}

export function getFormSubmissionById(submissionId, { firmId = null } = {}) {
  const row = firmId
    ? db.prepare('SELECT payload FROM form_submissions WHERE id = ? AND firm_id = ?').get(submissionId, firmId)
    : db.prepare('SELECT payload FROM form_submissions WHERE id = ?').get(submissionId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function listFormSubmissionsByFirm(firmId) {
  return db
    .prepare('SELECT payload FROM form_submissions WHERE firm_id = ? ORDER BY rowid ASC')
    .all(firmId)
    .map((row) => JSON.parse(row.payload))
}

export function listFormSubmissionsByClient(firmId, clientId) {
  return db
    .prepare('SELECT payload FROM form_submissions WHERE firm_id = ? AND client_id = ? ORDER BY rowid ASC')
    .all(firmId, clientId)
    .map((row) => JSON.parse(row.payload))
}

export function countFormSubmissionsByFirm(firmId) {
  return db.prepare('SELECT COUNT(*) AS count FROM form_submissions WHERE firm_id = ?').get(firmId)?.count || 0
}

export function deleteFormSubmission(submissionId, firmId) {
  const result = db.prepare('DELETE FROM form_submissions WHERE id = ? AND firm_id = ?').run(submissionId, firmId)
  return result.changes > 0
}

// First portal draft for a template, in insertion order — mirrors the old
// state.formSubmissions.find(...) that portalSubmit used to reuse drafts.
export function findPortalDraftSubmission(firmId, clientId, templateId) {
  const row = db
    .prepare(
      `
      SELECT payload FROM form_submissions
      WHERE firm_id = ? AND client_id = ? AND template_id = ? AND status = 'draft' AND source = 'portal'
      ORDER BY rowid ASC
      LIMIT 1
    `
    )
    .get(firmId, clientId, templateId)
  return row?.payload ? JSON.parse(row.payload) : null
}

// Newest submission for an export render context. Matches the old in-memory
// sort exactly: (submittedAt || createdAt) descending, id descending, and the
// legacy profileId alias is honored alongside clientId.
export function findLatestFormSubmissionForExport(firmId, clientId = null) {
  const normalizedClientId = clientId || null
  const row = db
    .prepare(
      `
      SELECT payload FROM form_submissions
      WHERE firm_id = ?
        AND (? IS NULL OR client_id = ? OR json_extract(payload, '$.profileId') = ?)
      ORDER BY COALESCE(json_extract(payload, '$.submittedAt'), json_extract(payload, '$.createdAt'), '') DESC, id DESC
      LIMIT 1
    `
    )
    .get(firmId, normalizedClientId, normalizedClientId, normalizedClientId)
  return row?.payload ? JSON.parse(row.payload) : null
}

// --- Portal draft section states (optimistic versioning) ---------------------
// PK (firm_id, client_id, draft_id, section_id); the version column is the
// optimistic-concurrency token. Writes are real row-level guards:
//   - expectedVersion 0 -> INSERT OR IGNORE (loses to any existing row)
//   - expectedVersion n -> UPDATE ... WHERE version = n
// Either failing returns { ok: false, conflict: true, state } with the latest
// row, preserving savePortalDraftSectionState's exact API contract.

function rowToSectionState(row) {
  if (!row) return null
  let data = {}
  try {
    data = row.payload ? JSON.parse(row.payload) : {}
  } catch {
    data = {}
  }
  return {
    firmId: row.firmId,
    clientId: row.clientId,
    draftId: row.draftId,
    sectionId: row.sectionId,
    version: Number(row.version || 0),
    data,
    updatedAt: row.updatedAt
  }
}

const SECTION_STATE_COLUMNS = `
  firm_id AS firmId,
  client_id AS clientId,
  draft_id AS draftId,
  section_id AS sectionId,
  version,
  updated_at AS updatedAt,
  payload
`

export function getDraftSectionState(firmId, clientId, draftId, sectionId) {
  const row = db
    .prepare(
      `
      SELECT ${SECTION_STATE_COLUMNS} FROM draft_step_states
      WHERE firm_id = ? AND client_id = ? AND draft_id = ? AND section_id = ?
    `
    )
    .get(firmId, clientId, draftId, sectionId)
  return rowToSectionState(row)
}

export function listDraftSectionStates(firmId, clientId, draftId) {
  return db
    .prepare(
      `
      SELECT ${SECTION_STATE_COLUMNS} FROM draft_step_states
      WHERE firm_id = ? AND client_id = ? AND draft_id = ?
      ORDER BY rowid ASC
    `
    )
    .all(firmId, clientId, draftId)
    .map(rowToSectionState)
}

export function saveDraftSectionStateGuarded({
  firmId,
  clientId,
  draftId,
  sectionId,
  expectedVersion,
  data,
  updatedAt
}) {
  const normalizedExpected = Number(expectedVersion || 0)
  const payload = JSON.stringify(data && typeof data === 'object' ? data : {})
  let applied = false
  if (normalizedExpected === 0) {
    const result = db
      .prepare(
        `
        INSERT OR IGNORE INTO draft_step_states (firm_id, client_id, draft_id, section_id, version, updated_at, payload)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `
      )
      .run(firmId, clientId, draftId, sectionId, updatedAt, payload)
    applied = result.changes > 0
  } else {
    const result = db
      .prepare(
        `
        UPDATE draft_step_states
        SET version = version + 1, updated_at = ?, payload = ?
        WHERE firm_id = ? AND client_id = ? AND draft_id = ? AND section_id = ? AND version = ?
      `
      )
      .run(updatedAt, payload, firmId, clientId, draftId, sectionId, normalizedExpected)
    applied = result.changes > 0
  }
  const state = getDraftSectionState(firmId, clientId, draftId, sectionId)
  if (!applied) {
    return { ok: false, conflict: true, state }
  }
  return { ok: true, state }
}

// --- Pending upload intents ---------------------------------------------------
// Presign flows insert an intent row; consuming an upload deletes it by id
// (unscoped delete matches the old filter-by-id semantics; lookups stay
// firm-scoped). Expired intents are swept by the lifecycle policies.

export function insertUploadIntent(intent) {
  db.prepare(
    `
    INSERT INTO pending_upload_intents (id, firm_id, client_id, expires_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      client_id = excluded.client_id,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      payload = excluded.payload
  `
  ).run(
    intent.id,
    intent.firmId ?? 'unknown',
    intent.clientId ?? null,
    intent.expiresAt ?? null,
    intent.createdAt ?? null,
    JSON.stringify(intent)
  )
  return intent
}

export function getUploadIntent(intentId, firmId) {
  const row = db
    .prepare('SELECT payload FROM pending_upload_intents WHERE id = ? AND firm_id = ?')
    .get(intentId, firmId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function deleteUploadIntent(intentId) {
  const result = db.prepare('DELETE FROM pending_upload_intents WHERE id = ?').run(intentId)
  return result.changes > 0
}

export function deleteExpiredUploadIntents(cutoffIso = nowIso()) {
  const result = db
    .prepare('DELETE FROM pending_upload_intents WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .run(cutoffIso)
  return result.changes
}

// Blob-to-table seeding for freshly seeded states (whose demo submissions
// exist only in memory) and any legacy blob that predates migration 005.
// Keyed INSERT OR IGNORE keeps it idempotent against the migration backfill.
function ensureSubmissionEntitiesSeededFromState(state) {
  const insertSubmission = db.prepare(`
    INSERT OR IGNORE INTO form_submissions (
      id, firm_id, client_id, template_id, status, source, created_by_user_id, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const submission of state.formSubmissions || []) {
    if (!submission || typeof submission !== 'object' || !submission.id) continue
    insertSubmission.run(...submissionParams(submission))
  }
  const insertSectionState = db.prepare(`
    INSERT OR IGNORE INTO draft_step_states (firm_id, client_id, draft_id, section_id, version, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const entry of state.draftStepStates || []) {
    if (!entry || typeof entry !== 'object') continue
    if (!entry.firmId || !entry.clientId || !entry.draftId || !entry.sectionId) continue
    insertSectionState.run(
      entry.firmId,
      entry.clientId,
      entry.draftId,
      entry.sectionId,
      Number(entry.version || 0),
      entry.updatedAt ?? null,
      JSON.stringify(entry.data && typeof entry.data === 'object' ? entry.data : {})
    )
  }
  const insertIntent = db.prepare(`
    INSERT OR IGNORE INTO pending_upload_intents (id, firm_id, client_id, expires_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const intent of state.pendingUploadIntents || []) {
    if (!intent || typeof intent !== 'object' || !intent.id) continue
    insertIntent.run(
      intent.id,
      intent.firmId ?? 'unknown',
      intent.clientId ?? null,
      intent.expiresAt ?? null,
      intent.createdAt ?? null,
      JSON.stringify(intent)
    )
  }
}

// --- Profile repository (source of truth) ------------------------------------
// The canonical profile object — including the envelope-encrypted
// pii.{ssnEncrypted,taxIdEncrypted,dobEncrypted} objects, which are stored
// verbatim inside the payload JSON — lives in the payload column. Promoted
// columns (tenancy, kind, stage, ordering, contact, financial summary) exist
// for keying, firm scoping, and the query paths SqliteReadRepository serves.
// Reads return JSON.parse(payload) so the object shape is exactly what the
// store wrote; the blob serializes profiles: [] purely for shape compat.

const PROFILE_UPSERT_SQL = `
  INSERT INTO profiles (
    id, firm_id, kind, first_name, last_name, email, phone, profile_status, stage,
    stage_order_index, order_index, source_city, source_venue, source_occurred_on,
    household_id, spouse_client_id, investable_assets, annual_income, total_assets,
    total_liabilities, net_worth, extensions_payload, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    firm_id = excluded.firm_id,
    kind = excluded.kind,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    email = excluded.email,
    phone = excluded.phone,
    profile_status = excluded.profile_status,
    stage = excluded.stage,
    stage_order_index = excluded.stage_order_index,
    order_index = excluded.order_index,
    source_city = excluded.source_city,
    source_venue = excluded.source_venue,
    source_occurred_on = excluded.source_occurred_on,
    household_id = excluded.household_id,
    spouse_client_id = excluded.spouse_client_id,
    investable_assets = excluded.investable_assets,
    annual_income = excluded.annual_income,
    total_assets = excluded.total_assets,
    total_liabilities = excluded.total_liabilities,
    net_worth = excluded.net_worth,
    extensions_payload = excluded.extensions_payload,
    payload = excluded.payload
`

function profileParams(profile) {
  return [
    profile.id,
    profile.firmId ?? 'unknown',
    profile.kind ?? 'prospect',
    profile.firstName ?? '',
    profile.lastName ?? '',
    profile.email || null,
    profile.phone || null,
    profile.status || null,
    profile.stage || null,
    profile.stageOrderIndex || null,
    profile.orderIndex ?? profile.stageOrderIndex ?? null,
    profile.source?.sourceCity ?? profile.source?.cityOrLocation ?? null,
    profile.source?.sourceVenue ?? profile.source?.venue ?? null,
    profile.source?.sourceDate ?? profile.source?.occurredOn ?? null,
    profile.householdId || null,
    profile.spouseClientId || null,
    Number(profile.financialSummary?.investableAssets || 0),
    Number(profile.financialSummary?.annualIncome || 0),
    Number(profile.financialSummary?.totalAssets || 0),
    Number(profile.financialSummary?.totalLiabilities || 0),
    Number(profile.financialSummary?.netWorth || 0),
    JSON.stringify(profile.extensions || {}),
    JSON.stringify(profile)
  ]
}

export function upsertProfileRow(profile) {
  db.prepare(PROFILE_UPSERT_SQL).run(...profileParams(profile))
  return profile
}

// Unscoped by default: tenancy validation happens in the store via
// validateEntityOwnership so that a cross-firm id surfaces the same
// "Profile not found." tenancy error the in-memory find produced (instead of
// silently behaving like a missing row).
export function getProfileRow(profileId, { firmId = null } = {}) {
  const row = firmId
    ? db.prepare('SELECT payload FROM profiles WHERE id = ? AND firm_id = ?').get(profileId, firmId)
    : db.prepare('SELECT payload FROM profiles WHERE id = ?').get(profileId)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function deleteProfileRow(profileId, firmId) {
  const result = db.prepare('DELETE FROM profiles WHERE id = ? AND firm_id = ?').run(profileId, firmId)
  return result.changes > 0
}

// Insertion order (rowid ASC — the upsert is ON CONFLICT DO UPDATE, which
// preserves rowid) mirrors the old state.profiles push order that dashboard
// "recent profiles" and the store's own sort-then-filter readers relied on.
export function listProfileRows({ firmId = null } = {}) {
  const rows = firmId
    ? db.prepare('SELECT payload FROM profiles WHERE firm_id = ? ORDER BY rowid ASC').all(firmId)
    : db.prepare('SELECT payload FROM profiles ORDER BY rowid ASC').all()
  return rows.map((row) => JSON.parse(row.payload))
}

// Board column read: prospects of one stage, ordered exactly like the old
// in-memory listProspectsByStage (orderIndex with non-positive treated as
// +infinity, then updatedAt/createdAt recency, then id).
export function listProspectRowsByStage(firmId, stage, excludedProfileId = null) {
  return db
    .prepare(
      `
      SELECT payload FROM profiles
      WHERE firm_id = ? AND kind = 'prospect' AND stage = ? AND (? IS NULL OR id != ?)
      ORDER BY
        CASE
          WHEN COALESCE(order_index, stage_order_index) > 0 THEN COALESCE(order_index, stage_order_index)
          ELSE 9007199254740991
        END,
        COALESCE(json_extract(payload, '$.updatedAt'), json_extract(payload, '$.createdAt'), '') ,
        id
    `
    )
    .all(firmId, stage, excludedProfileId, excludedProfileId)
    .map((row) => JSON.parse(row.payload))
}

export function countProspectRowsInStage(firmId, stage) {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM profiles WHERE firm_id = ? AND kind = 'prospect' AND stage = ?")
      .get(firmId, stage)?.count || 0
  )
}

// Distinct stage ids carried by prospects of a firm — feeds the legacy-stage
// bucket computation in getFirmPipelineStageDefinitions.
export function listProspectStageIds(firmId) {
  return db
    .prepare(
      "SELECT DISTINCT stage FROM profiles WHERE firm_id = ? AND kind = 'prospect' AND stage IS NOT NULL AND TRIM(stage) != ''"
    )
    .all(firmId)
    .map((row) => String(row.stage).trim())
}

// First client profile whose email matches (case-insensitive), in insertion
// order — mirrors the old state.profiles.find for portal client resolution.
export function findClientProfileRowByEmail(firmId, email) {
  const normalized = String(email || '').toLowerCase()
  if (!normalized) return null
  const row = db
    .prepare(
      `
      SELECT payload FROM profiles
      WHERE firm_id = ? AND kind = 'client' AND email IS NOT NULL AND lower(email) = ?
      ORDER BY rowid ASC
      LIMIT 1
    `
    )
    .get(firmId, normalized)
  return row?.payload ? JSON.parse(row.payload) : null
}

// --- Stage change repository (append-only) ------------------------------------

export function insertStageChange(change) {
  if (!change || typeof change !== 'object') return false
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO stage_changes (
        id, firm_id, client_id, from_stage, to_stage, changed_by_user_id, changed_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      change.id || randomUUID(),
      change.firmId ?? 'unknown',
      change.clientId ?? null,
      change.fromStage ?? null,
      change.toStage ?? null,
      change.changedByUserId ?? null,
      change.changedAt ?? null,
      JSON.stringify(change)
    )
  return result.changes > 0
}

// rowid ASC mirrors the old in-memory push order.
export function listStageChangeRowsByFirm(firmId) {
  return db
    .prepare('SELECT payload FROM stage_changes WHERE firm_id = ? ORDER BY rowid ASC')
    .all(firmId)
    .map((row) => JSON.parse(row.payload))
}

export function listStageChangeRowsByClient(firmId, clientId) {
  return db
    .prepare('SELECT payload FROM stage_changes WHERE firm_id = ? AND client_id = ? ORDER BY rowid ASC')
    .all(firmId, clientId)
    .map((row) => JSON.parse(row.payload))
}

// --- Board version repository (optimistic-concurrency primitive) ---------------
// One row per firm; reading through ensureBoardVersionRow lazily creates the
// row at version 1 (the old getBoardVersion defaulted missing firms to 1).

export function ensureBoardVersionRow(firmId) {
  db.prepare('INSERT OR IGNORE INTO board_versions (firm_id, version) VALUES (?, 1)').run(firmId)
  return Number(db.prepare('SELECT version FROM board_versions WHERE firm_id = ?').get(firmId)?.version || 1)
}

export function setBoardVersionRow(firmId, version) {
  db.prepare(
    `
    INSERT INTO board_versions (firm_id, version) VALUES (?, ?)
    ON CONFLICT(firm_id) DO UPDATE SET version = excluded.version
  `
  ).run(firmId, Number(version) > 0 ? Math.trunc(Number(version)) : 1)
}

// Guarded increment: UPDATE ... WHERE version = expected. Returns the new
// version on success, or null when another writer already moved the board —
// the caller surfaces the standard PIPELINE_ORDER_CONFLICT contract.
export function incrementBoardVersionGuarded(firmId, expectedVersion) {
  const expected = Number(expectedVersion)
  const result = db
    .prepare('UPDATE board_versions SET version = version + 1 WHERE firm_id = ? AND version = ?')
    .run(firmId, expected)
  if (result.changes === 0) return null
  return expected + 1
}

// --- Pipeline stage record repository (source of truth) ------------------------
// Stage config rows are fully column-mapped (no payload column): the record
// shape is small, flat, and versionless.

function rowToStageRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    firmId: row.firmId,
    key: row.key,
    label: row.label ?? null,
    color: row.color ?? null,
    isActive: Number(row.isActive) !== 0,
    order: row.sortOrder == null ? null : Number(row.sortOrder),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    deactivatedAt: row.deactivatedAt ?? null
  }
}

const STAGE_RECORD_COLUMNS = `
  id,
  firm_id AS firmId,
  key,
  label,
  color,
  is_active AS isActive,
  sort_order AS sortOrder,
  created_at AS createdAt,
  updated_at AS updatedAt,
  deactivated_at AS deactivatedAt
`

export function upsertPipelineStageRecord(record) {
  db.prepare(
    `
    INSERT INTO pipeline_stage_records (
      id, firm_id, key, label, color, is_active, sort_order, created_at, updated_at, deactivated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      key = excluded.key,
      label = excluded.label,
      color = excluded.color,
      is_active = excluded.is_active,
      sort_order = excluded.sort_order,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deactivated_at = excluded.deactivated_at
  `
  ).run(
    record.id,
    record.firmId,
    record.key,
    record.label ?? null,
    record.color ?? null,
    record.isActive === false ? 0 : 1,
    Number.isFinite(Number(record.order)) ? Number(record.order) : null,
    record.createdAt ?? null,
    record.updatedAt ?? null,
    record.deactivatedAt ?? null
  )
  return record
}

// Same ordering the old in-memory bridge used: sort_order then key.
export function listPipelineStageRecordRows(firmId) {
  return db
    .prepare(
      `SELECT ${STAGE_RECORD_COLUMNS} FROM pipeline_stage_records WHERE firm_id = ? ORDER BY COALESCE(sort_order, 0) ASC, key ASC`
    )
    .all(firmId)
    .map(rowToStageRecord)
}

export function getPipelineStageRecordRow(stageId) {
  const row = db.prepare(`SELECT ${STAGE_RECORD_COLUMNS} FROM pipeline_stage_records WHERE id = ?`).get(stageId)
  return rowToStageRecord(row)
}

export function countPipelineStageRecordRows(firmId) {
  return db.prepare('SELECT COUNT(*) AS count FROM pipeline_stage_records WHERE firm_id = ?').get(firmId)?.count || 0
}

// Blob-to-table seeding for freshly seeded states (whose demo profiles and
// stage changes exist only in memory) and any legacy blob that predates
// migration 006. Keyed INSERT OR IGNORE / OR-IGNORE-style guards keep it
// idempotent against the migration backfill.
function ensureBoardEntitiesSeededFromState(state) {
  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO profiles (
      id, firm_id, kind, first_name, last_name, email, phone, profile_status, stage,
      stage_order_index, order_index, source_city, source_venue, source_occurred_on,
      household_id, spouse_client_id, investable_assets, annual_income, total_assets,
      total_liabilities, net_worth, extensions_payload, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const profile of state.profiles || []) {
    if (!profile || typeof profile !== 'object' || !profile.id) continue
    insertProfile.run(...profileParams(profile))
  }
  for (const change of state.stageChanges || []) {
    insertStageChange(change)
  }
  const boardVersions =
    state.boardVersions && typeof state.boardVersions === 'object' && !Array.isArray(state.boardVersions)
      ? state.boardVersions
      : {}
  const insertBoardVersion = db.prepare('INSERT OR IGNORE INTO board_versions (firm_id, version) VALUES (?, ?)')
  for (const [firmId, version] of Object.entries(boardVersions)) {
    if (!firmId) continue
    const numeric = Number(version)
    insertBoardVersion.run(firmId, Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 1)
  }
  const insertStageRecord = db.prepare(`
    INSERT OR IGNORE INTO pipeline_stage_records (
      id, firm_id, key, label, color, is_active, sort_order, created_at, updated_at, deactivated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const record of state.pipelineStages || []) {
    if (!record || typeof record !== 'object' || !record.firmId) continue
    const key = String(record.key || record.id || '').trim()
    if (!key) continue
    insertStageRecord.run(
      record.id || randomUUID(),
      record.firmId,
      key,
      record.label ?? null,
      record.color ?? null,
      record.isActive === false ? 0 : 1,
      Number.isFinite(Number(record.order)) ? Number(record.order) : null,
      record.createdAt ?? null,
      record.updatedAt ?? null,
      record.deactivatedAt ?? null
    )
  }
}

// --- Notes repository (source of truth) --------------------------------------
// Before migration 007 the notes table was a derived projection destructively
// rebuilt on every saveState; it is now the sole source of truth, written by
// upsertNoteRow. The full canonical note (including any encrypted bodyEncrypted
// envelope) lives in the payload column; firm_id/profile_id/created_at are
// promoted for keying and firm-scoped reads. Reads return payloads in
// insertion order (rowid ASC), mirroring the old state.notes push order the
// store's reverse()/filter readers relied on.

export function upsertNoteRow(note) {
  db.prepare(
    `
    INSERT INTO notes (id, firm_id, profile_id, created_at, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      profile_id = excluded.profile_id,
      created_at = excluded.created_at,
      payload = excluded.payload
  `
  ).run(note.id, note.firmId ?? 'unknown', note.profileId ?? 'unknown', note.createdAt ?? null, JSON.stringify(note))
  return note
}

export function listNoteRowsByProfile(firmId, profileId) {
  return db
    .prepare('SELECT payload FROM notes WHERE firm_id = ? AND profile_id = ? ORDER BY rowid ASC')
    .all(firmId, profileId)
    .map((row) => JSON.parse(row.payload))
}

export function listNoteRowsByFirm(firmId) {
  return db
    .prepare('SELECT payload FROM notes WHERE firm_id = ? ORDER BY rowid ASC')
    .all(firmId)
    .map((row) => JSON.parse(row.payload))
}

// --- Document upload repository (source of truth) -----------------------------
// The full upload object — object{bucket,key,checksum,contentType,
// retentionClass}, malwareScan, visibility, retention timestamps — lives in
// the payload column; firm_id/client_id/status are promoted for scoped reads
// and the lifecycle sweep. applyLifecyclePolicies iterates every row
// (unscoped) and writes each mutated upload back via upsertDocumentUploadRow.

export function upsertDocumentUploadRow(upload) {
  db.prepare(
    `
    INSERT INTO document_uploads (id, firm_id, client_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      client_id = excluded.client_id,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      payload = excluded.payload
  `
  ).run(
    upload.id,
    upload.firmId ?? 'unknown',
    upload.clientId ?? null,
    upload.status ?? null,
    upload.createdAt ?? null,
    upload.updatedAt ?? upload.createdAt ?? null,
    JSON.stringify(upload)
  )
  return upload
}

// Unscoped full-table read for the retention/lifecycle sweep, which mutates
// uploads across every firm in one pass.
export function listAllDocumentUploadRows() {
  return db
    .prepare('SELECT payload FROM document_uploads ORDER BY rowid ASC')
    .all()
    .map((row) => JSON.parse(row.payload))
}

export function listDocumentUploadRowsByFirm(firmId) {
  return db
    .prepare('SELECT payload FROM document_uploads WHERE firm_id = ? ORDER BY rowid ASC')
    .all(firmId)
    .map((row) => JSON.parse(row.payload))
}

export function listDocumentUploadRowsByFirmClient(firmId, clientId) {
  return db
    .prepare('SELECT payload FROM document_uploads WHERE firm_id = ? AND client_id = ? ORDER BY rowid ASC')
    .all(firmId, clientId)
    .map((row) => JSON.parse(row.payload))
}

export function getDocumentUploadRow(uploadId, { firmId = null, clientId = null } = {}) {
  const conditions = ['id = ?']
  const params = [uploadId]
  if (firmId !== null) {
    conditions.push('firm_id = ?')
    params.push(firmId)
  }
  if (clientId !== null) {
    conditions.push('client_id = ?')
    params.push(clientId)
  }
  const row = db.prepare(`SELECT payload FROM document_uploads WHERE ${conditions.join(' AND ')}`).get(...params)
  return row?.payload ? JSON.parse(row.payload) : null
}

// --- Portal link repository (source of truth) --------------------------------
// The full link object (scope, usedCount, lastUsedAt) lives in the payload
// column; firm_id/profile_id/token/created_at/expires_at/revoked_at are
// promoted. token is UNIQUE — portal access resolves a single link by token.

export function upsertPortalLinkRow(link) {
  db.prepare(
    `
    INSERT INTO portal_links (id, firm_id, profile_id, token, created_at, expires_at, revoked_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      profile_id = excluded.profile_id,
      token = excluded.token,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      revoked_at = excluded.revoked_at,
      payload = excluded.payload
  `
  ).run(
    link.id,
    link.firmId ?? 'unknown',
    link.profileId ?? null,
    link.token,
    link.createdAt ?? null,
    link.expiresAt ?? null,
    link.revokedAt ?? null,
    JSON.stringify(link)
  )
  return link
}

export function findPortalLinkRowByToken(token) {
  const row = db.prepare('SELECT payload FROM portal_links WHERE token = ?').get(token)
  return row?.payload ? JSON.parse(row.payload) : null
}

// Unscoped by id: tenancy validation happens in the store (validateEntityOwnership)
// so a cross-firm id surfaces the same "Portal link not found." tenancy error.
export function getPortalLinkRow(linkId) {
  const row = db.prepare('SELECT payload FROM portal_links WHERE id = ?').get(linkId)
  return row?.payload ? JSON.parse(row.payload) : null
}

// --- Invite repository (source of truth) -------------------------------------
// The full invite object lives in the payload column; firm_id/token/email/role
// are promoted. token is UNIQUE — invite acceptance resolves a single invite
// by token. Accepting an invite deletes the row by id.

export function upsertInviteRow(invite) {
  db.prepare(
    `
    INSERT INTO invites (id, firm_id, token, email, role, created_at, expires_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firm_id = excluded.firm_id,
      token = excluded.token,
      email = excluded.email,
      role = excluded.role,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      payload = excluded.payload
  `
  ).run(
    invite.id,
    invite.firmId ?? 'unknown',
    invite.token,
    invite.email ?? null,
    invite.role ?? null,
    invite.createdAt ?? null,
    invite.expiresAt ?? null,
    JSON.stringify(invite)
  )
  return invite
}

export function findInviteRowByToken(token) {
  const row = db.prepare('SELECT payload FROM invites WHERE token = ?').get(token)
  return row?.payload ? JSON.parse(row.payload) : null
}

export function deleteInviteRow(inviteId) {
  const result = db.prepare('DELETE FROM invites WHERE id = ?').run(inviteId)
  return result.changes > 0
}

// --- Notification repository (source of truth) --------------------------------
// In-app notifications (migration 011). The canonical object — title, body,
// link, entity refs — lives in the payload JSON column; firm_id/user_id/type/
// read_at/created_at are promoted for the scoped list, unread-count, and
// mark-read paths. A NULL user_id is a firm-wide notification: every scoped
// read matches (user_id = ? OR user_id IS NULL). read_at NULL means unread.
//
// insertNotification runs from BOTH the API process (its inline queue tick) and
// the standalone export worker (they share this database), so an export-
// completion notification is created exactly once by whichever process
// finalizes the job — the row is relational, so either writer is fine.

function mapNotificationRow(row) {
  const payload = row.payload ? JSON.parse(row.payload) : {}
  return {
    id: row.id,
    firmId: row.firm_id,
    userId: row.user_id,
    type: row.type,
    readAt: row.read_at,
    createdAt: row.created_at,
    ...payload
  }
}

export function insertNotification(notification) {
  const id = notification.id || randomUUID()
  const createdAt = notification.createdAt || nowIso()
  const payload = {
    title: notification.title || '',
    body: notification.body || '',
    link: notification.link || null,
    entityType: notification.entityType || null,
    entityId: notification.entityId || null
  }
  if (notification.metadata && typeof notification.metadata === 'object') {
    payload.metadata = notification.metadata
  }
  db.prepare(
    `
    INSERT OR IGNORE INTO notifications (id, firm_id, user_id, type, read_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    notification.firmId ?? 'unknown',
    notification.userId ?? null,
    notification.type || 'generic',
    notification.readAt ?? null,
    createdAt,
    JSON.stringify(payload)
  )
  return {
    id,
    firmId: notification.firmId ?? 'unknown',
    userId: notification.userId ?? null,
    type: notification.type || 'generic',
    readAt: notification.readAt ?? null,
    createdAt,
    ...payload
  }
}

// Recipient view: the user's own notifications plus firm-wide ones, newest
// first. rowid DESC is the stable tiebreak when created_at collides.
export function listNotificationsForUser({ firmId, userId = null, unreadOnly = false, limit = 50 } = {}) {
  const clauses = ['firm_id = ?', '(user_id = ? OR user_id IS NULL)']
  const params = [firmId, userId]
  if (unreadOnly) clauses.push('read_at IS NULL')
  params.push(Math.max(1, Math.min(Number(limit) || 50, 200)))
  return db
    .prepare(`SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params)
    .map(mapNotificationRow)
}

export function countUnreadNotifications({ firmId, userId = null } = {}) {
  return (
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM notifications WHERE firm_id = ? AND (user_id = ? OR user_id IS NULL) AND read_at IS NULL'
      )
      .get(firmId, userId)?.count || 0
  )
}

// Idempotent: COALESCE preserves the original read timestamp on re-mark. The
// changes count is nonzero when a scoped row matched (existence + ownership).
export function markNotificationRead(id, { firmId, userId = null, readAt = null } = {}) {
  const stamp = readAt || nowIso()
  return (
    db
      .prepare(
        'UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND firm_id = ? AND (user_id = ? OR user_id IS NULL)'
      )
      .run(stamp, id, firmId, userId).changes > 0
  )
}

export function markAllNotificationsRead({ firmId, userId = null, readAt = null } = {}) {
  const stamp = readAt || nowIso()
  return db
    .prepare(
      'UPDATE notifications SET read_at = ? WHERE firm_id = ? AND (user_id = ? OR user_id IS NULL) AND read_at IS NULL'
    )
    .run(stamp, firmId, userId).changes
}

// Optional retention sweep: drop notifications created at/older than the cutoff.
export function deleteExpiredNotifications(cutoffIso) {
  return db.prepare('DELETE FROM notifications WHERE created_at <= ?').run(cutoffIso).changes
}

// Blob-to-table seeding for freshly seeded states (whose demo notes/uploads
// exist only in memory) and any legacy blob that predates migration 007.
// Keyed INSERT OR IGNORE keeps it idempotent against the migration backfill.
function ensureClientDataEntitiesSeededFromState(state) {
  const insertNote = db.prepare(`
    INSERT OR IGNORE INTO notes (id, firm_id, profile_id, created_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const note of state.notes || []) {
    if (!note || typeof note !== 'object' || !note.id) continue
    insertNote.run(
      note.id,
      note.firmId ?? 'unknown',
      note.profileId ?? 'unknown',
      note.createdAt ?? null,
      JSON.stringify(note)
    )
  }
  const insertUpload = db.prepare(`
    INSERT OR IGNORE INTO document_uploads (id, firm_id, client_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const upload of state.documentUploads || []) {
    if (!upload || typeof upload !== 'object' || !upload.id) continue
    insertUpload.run(
      upload.id,
      upload.firmId ?? 'unknown',
      upload.clientId ?? null,
      upload.status ?? null,
      upload.createdAt ?? null,
      upload.updatedAt ?? upload.createdAt ?? null,
      JSON.stringify(upload)
    )
  }
  const insertPortalLink = db.prepare(`
    INSERT OR IGNORE INTO portal_links (id, firm_id, profile_id, token, created_at, expires_at, revoked_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const link of state.portalLinks || []) {
    if (!link || typeof link !== 'object' || !link.id || !link.token) continue
    insertPortalLink.run(
      link.id,
      link.firmId ?? 'unknown',
      link.profileId ?? null,
      link.token,
      link.createdAt ?? null,
      link.expiresAt ?? null,
      link.revokedAt ?? null,
      JSON.stringify(link)
    )
  }
  const insertInvite = db.prepare(`
    INSERT OR IGNORE INTO invites (id, firm_id, token, email, role, created_at, expires_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const invite of state.invites || []) {
    if (!invite || typeof invite !== 'object' || !invite.id || !invite.token) continue
    insertInvite.run(
      invite.id,
      invite.firmId ?? 'unknown',
      invite.token,
      invite.email ?? null,
      invite.role ?? null,
      invite.createdAt ?? null,
      invite.expiresAt ?? null,
      JSON.stringify(invite)
    )
  }
}

// Notifications are a source-of-truth table with no legacy blob predecessor,
// so this only seeds any in-memory notifications a freshly seeded state might
// carry (today none do). Keyed INSERT OR IGNORE keeps it idempotent.
function ensureNotificationsSeededFromState(state) {
  const insertRow = db.prepare(`
    INSERT OR IGNORE INTO notifications (id, firm_id, user_id, type, read_at, created_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const notification of state.notifications || []) {
    if (!notification || typeof notification !== 'object' || !notification.id) continue
    const { id, firmId, userId, type, readAt, createdAt, ...rest } = notification
    insertRow.run(
      id,
      firmId ?? 'unknown',
      userId ?? null,
      type || 'generic',
      readAt ?? null,
      createdAt ?? nowIso(),
      JSON.stringify(rest)
    )
  }
}

// --- Auth entity repositories (sources of truth) -----------------------------
// Four ephemeral, security-critical entities: the login-attempt log
// (auth_attempts), the reset-request log (password_reset_attempts), reset
// tokens (password_resets), and pending MFA login challenges (mfa_challenges).
// The tables are columns-only (no payload JSON): each record is small and flat,
// fully described by its columns. Rate limiting and expiry — which the store
// used to compute with an in-memory pruneByAge + filter/count — are now
// enforced directly in SQL: COUNT(...) WHERE ... AND created_at > cutoff, and
// expires_at <= now comparisons. All timestamps are ISO-8601 UTC strings, so
// the cutoff comparisons are exact under lexicographic ordering. The blob
// serializes empty arrays for the four keys purely for shape compatibility.
//
// Insert paths accept a pruneCutoff and delete rows at/older than it before
// inserting, in one transaction — this mirrors pruneByAge running on every
// write and keeps these ephemeral tables from growing without bound. Deleting
// rows at/before the cutoff never changes a subsequent COUNT (which filters
// created_at > cutoff / uses live expiry), so pruning is semantics-preserving.

export function insertAuthAttempt(attempt, { pruneCutoff = null } = {}) {
  runInTransaction(() => {
    if (pruneCutoff) db.prepare('DELETE FROM auth_attempts WHERE created_at <= ?').run(pruneCutoff)
    db.prepare('INSERT INTO auth_attempts (id, email, ip_address, ok, created_at) VALUES (?, ?, ?, ?, ?)').run(
      attempt.id || randomUUID(),
      attempt.email ?? null,
      attempt.ipAddress ?? null,
      attempt.ok ? 1 : 0,
      attempt.createdAt ?? nowIso()
    )
  })
}

// Failed logins within the window: ok = 0 AND created_at > cutoff. Matches the
// old pruneByAge(window) + filter(email && !ok).length count exactly.
export function countFailedLoginsByEmail(email, cutoffIso) {
  return (
    db
      .prepare('SELECT COUNT(*) AS count FROM auth_attempts WHERE email = ? AND ok = 0 AND created_at > ?')
      .get(email, cutoffIso)?.count || 0
  )
}

export function countFailedLoginsByIp(ipAddress, cutoffIso) {
  return (
    db
      .prepare('SELECT COUNT(*) AS count FROM auth_attempts WHERE ip_address = ? AND ok = 0 AND created_at > ?')
      .get(ipAddress, cutoffIso)?.count || 0
  )
}

// Successful login clears every attempt for the email (the old code inserted an
// ok=1 row then clearLoginAttempts deleted all rows for the email; the net
// effect is "no attempts remain for that email").
export function deleteAuthAttemptsByEmail(email) {
  return db.prepare('DELETE FROM auth_attempts WHERE email = ?').run(email).changes
}

export function deleteExpiredAuthAttempts(cutoffIso) {
  return db.prepare('DELETE FROM auth_attempts WHERE created_at <= ?').run(cutoffIso).changes
}

export function insertPasswordResetAttempt(attempt, { pruneCutoff = null } = {}) {
  runInTransaction(() => {
    if (pruneCutoff) db.prepare('DELETE FROM password_reset_attempts WHERE created_at <= ?').run(pruneCutoff)
    db.prepare('INSERT INTO password_reset_attempts (id, email, ip_address, created_at) VALUES (?, ?, ?, ?)').run(
      attempt.id || randomUUID(),
      attempt.email ?? null,
      attempt.ipAddress ?? null,
      attempt.createdAt ?? nowIso()
    )
  })
}

export function countResetAttemptsByEmail(email, cutoffIso) {
  return (
    db
      .prepare('SELECT COUNT(*) AS count FROM password_reset_attempts WHERE email = ? AND created_at > ?')
      .get(email, cutoffIso)?.count || 0
  )
}

export function countResetAttemptsByIp(ipAddress, cutoffIso) {
  return (
    db
      .prepare('SELECT COUNT(*) AS count FROM password_reset_attempts WHERE ip_address = ? AND created_at > ?')
      .get(ipAddress, cutoffIso)?.count || 0
  )
}

export function deleteExpiredPasswordResetAttempts(cutoffIso) {
  return db.prepare('DELETE FROM password_reset_attempts WHERE created_at <= ?').run(cutoffIso).changes
}

const PASSWORD_RESET_COLUMNS = `
  id,
  user_id AS userId,
  token,
  created_at AS createdAt,
  expires_at AS expiresAt
`

export function insertPasswordReset(reset, { pruneCutoff = null } = {}) {
  runInTransaction(() => {
    if (pruneCutoff) db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(pruneCutoff)
    db.prepare('INSERT INTO password_resets (id, user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      reset.id || randomUUID(),
      reset.userId ?? null,
      reset.token,
      reset.createdAt ?? nowIso(),
      reset.expiresAt ?? null
    )
  })
  return reset
}

export function findPasswordResetByToken(token) {
  return db.prepare(`SELECT ${PASSWORD_RESET_COLUMNS} FROM password_resets WHERE token = ?`).get(token) || null
}

export function deletePasswordResetsByUser(userId) {
  return db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId).changes
}

export function deletePasswordResetById(id) {
  return db.prepare('DELETE FROM password_resets WHERE id = ?').run(id).changes
}

// Test-only support: upsert an existing reset by id so a test can push its
// expiresAt into the past (mirrors the old store.state.passwordResets mutation).
export function upsertPasswordResetRow(reset) {
  db.prepare(
    `
    INSERT INTO password_resets (id, user_id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      token = excluded.token,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `
  ).run(reset.id, reset.userId ?? null, reset.token, reset.createdAt ?? null, reset.expiresAt ?? null)
  return reset
}

const MFA_CHALLENGE_COLUMNS = `
  id,
  token,
  user_id AS userId,
  method,
  created_at AS createdAt,
  expires_at AS expiresAt
`

export function insertMfaChallenge(challenge, { pruneCutoff = null } = {}) {
  runInTransaction(() => {
    if (pruneCutoff) db.prepare('DELETE FROM mfa_challenges WHERE expires_at <= ?').run(pruneCutoff)
    db.prepare(
      'INSERT INTO mfa_challenges (id, token, user_id, method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      challenge.id || randomUUID(),
      challenge.token,
      challenge.userId ?? null,
      challenge.method ?? null,
      challenge.createdAt ?? nowIso(),
      challenge.expiresAt ?? null
    )
  })
  return challenge
}

// MFA consume path: resolve a single challenge by token scoped to the user, the
// same match the old state.mfaChallenges.find(token && userId) performed.
export function findMfaChallengeByTokenAndUser(token, userId) {
  return db.prepare(`SELECT ${MFA_CHALLENGE_COLUMNS} FROM mfa_challenges WHERE token = ? AND user_id = ?`).get(token, userId) || null
}

export function deleteMfaChallengesByUser(userId) {
  return db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(userId).changes
}

export function deleteMfaChallengeById(id) {
  return db.prepare('DELETE FROM mfa_challenges WHERE id = ?').run(id).changes
}

// Blob-to-table seeding for freshly seeded states and any legacy blob that
// predates migration 008. Keyed INSERT OR IGNORE keeps it idempotent against
// the migration backfill.
function ensureAuthEntitiesSeededFromState(state) {
  const insertAuth = db.prepare(`
    INSERT OR IGNORE INTO auth_attempts (id, email, ip_address, ok, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const attempt of state.authAttempts || []) {
    if (!attempt || typeof attempt !== 'object' || !attempt.id) continue
    insertAuth.run(attempt.id, attempt.email ?? null, attempt.ipAddress ?? null, attempt.ok ? 1 : 0, attempt.createdAt ?? null)
  }
  const insertResetAttempt = db.prepare(`
    INSERT OR IGNORE INTO password_reset_attempts (id, email, ip_address, created_at)
    VALUES (?, ?, ?, ?)
  `)
  for (const attempt of state.passwordResetAttempts || []) {
    if (!attempt || typeof attempt !== 'object' || !attempt.id) continue
    insertResetAttempt.run(attempt.id, attempt.email ?? null, attempt.ipAddress ?? null, attempt.createdAt ?? null)
  }
  const insertReset = db.prepare(`
    INSERT OR IGNORE INTO password_resets (id, user_id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const reset of state.passwordResets || []) {
    if (!reset || typeof reset !== 'object' || !reset.id || !reset.token) continue
    insertReset.run(reset.id, reset.userId ?? null, reset.token, reset.createdAt ?? null, reset.expiresAt ?? null)
  }
  const insertChallenge = db.prepare(`
    INSERT OR IGNORE INTO mfa_challenges (id, token, user_id, method, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const challenge of state.mfaChallenges || []) {
    if (!challenge || typeof challenge !== 'object' || !challenge.id || !challenge.token) continue
    insertChallenge.run(
      challenge.id,
      challenge.token,
      challenge.userId ?? null,
      challenge.method ?? null,
      challenge.createdAt ?? null,
      challenge.expiresAt ?? null
    )
  }
}

function syncAnalyticsMaterialized(state) {
  db.exec('DELETE FROM analytics_materialized')
  // firms/users are relational sources of truth (the blob serializes empty
  // arrays), so the analytics aggregation reads them from their tables.
  const firms = listFirmRows()
  const byFirm = new Map()
  firms.forEach((firm) =>
    byFirm.set(firm.id, {
      firmId: firm.id,
      generatedAt: nowIso(),
      funnel: {},
      stageAgingDays: {},
      formCompletionRates: {},
      advisorProductivity: {}
    })
  )
  // profiles is the relational source of truth (the blob serializes an empty
  // array), so the funnel/aging aggregates read the table.
  db.prepare(
    `
    SELECT firm_id AS firmId, stage,
      json_extract(payload, '$.updatedAt') AS updatedAt,
      json_extract(payload, '$.createdAt') AS createdAt
    FROM profiles
    WHERE kind = 'prospect'
  `
  )
    .all()
    .forEach((profile) => {
      const summary = byFirm.get(profile.firmId)
      if (!summary) return
      const stage = profile.stage || 'unassigned'
      summary.funnel[stage] = (summary.funnel[stage] || 0) + 1
      const ageDays = Math.max(
        0,
        (Date.now() - new Date(profile.updatedAt || profile.createdAt || nowIso()).getTime()) / 86_400_000
      )
      const age = summary.stageAgingDays[stage] || { count: 0, sumDays: 0 }
      age.count += 1
      age.sumDays += ageDays
      summary.stageAgingDays[stage] = age
    })
  // form_submissions is the relational source of truth (the blob serializes
  // an empty array), so completion rates aggregate over the table.
  db.prepare('SELECT firm_id AS firmId, template_id AS templateId, status FROM form_submissions')
    .all()
    .forEach((submission) => {
      const summary = byFirm.get(submission.firmId)
      if (!summary) return
      const key = submission.templateId || 'unknown'
      const bucket = summary.formCompletionRates[key] || { templateId: key, drafts: 0, submitted: 0 }
      if (submission.status === 'submitted') bucket.submitted += 1
      else bucket.drafts += 1
      summary.formCompletionRates[key] = bucket
    })

  const usersById = new Map(listUserRows().map((user) => [user.id, user]))
  // notes is the relational source of truth (the blob serializes an empty
  // array), so notes-authored counts aggregate over the table. createdByUserId
  // is not a promoted column, so it is read from the payload JSON.
  db.prepare(
    "SELECT firm_id AS firmId, json_extract(payload, '$.createdByUserId') AS createdByUserId FROM notes"
  )
    .all()
    .forEach((note) => {
      const actor = usersById.get(note.createdByUserId)
      if (!actor) return
      const summary = byFirm.get(note.firmId)
      if (!summary) return
      const key = actor.id
      const bucket = summary.advisorProductivity[key] || {
        advisorUserId: key,
        advisorName: `${actor.firstName} ${actor.lastName}`,
        notesAuthored: 0,
        stageMoves: 0
      }
      bucket.notesAuthored += 1
      summary.advisorProductivity[key] = bucket
    })
  // stage_changes is the relational source of truth for stage-move counts.
  db.prepare('SELECT firm_id AS firmId, changed_by_user_id AS changedByUserId FROM stage_changes')
    .all()
    .forEach((change) => {
      const actor = usersById.get(change.changedByUserId)
      if (!actor) return
      const summary = byFirm.get(change.firmId)
      if (!summary) return
      const key = actor.id
      const bucket = summary.advisorProductivity[key] || {
        advisorUserId: key,
        advisorName: `${actor.firstName} ${actor.lastName}`,
        notesAuthored: 0,
        stageMoves: 0
      }
      bucket.stageMoves += 1
      summary.advisorProductivity[key] = bucket
    })

  const insert = db.prepare(`
    INSERT INTO analytics_materialized (firm_id, payload, updated_at)
    VALUES (?, ?, ?)
  `)
  byFirm.forEach((summary, firmId) => {
    Object.values(summary.stageAgingDays).forEach((entry) => {
      entry.avgDays = entry.count ? Number((entry.sumDays / entry.count).toFixed(2)) : 0
      delete entry.sumDays
    })
    Object.values(summary.formCompletionRates).forEach((entry) => {
      const total = entry.drafts + entry.submitted
      entry.completionRate = total ? Number((entry.submitted / total).toFixed(4)) : 0
    })
    Object.values(summary.advisorProductivity).forEach((entry) => {
      entry.productivityScore = entry.notesAuthored + entry.stageMoves
    })
    insert.run(firmId, JSON.stringify(summary), nowIso())
  })
}

export function ensureDatabaseReady() {
  db.prepare('SELECT 1').get()
  return {
    ok: true,
    dbPath: DB_PATH,
    exists: existsSync(DB_PATH)
  }
}

export function closeDatabase() {
  db.close()
}

function stripRelationalMirrors(state) {
  state.firms = []
  state.users = []
  state.households = []
  state.formTemplates = []
  state.documentTemplates = []
  state.templateAggregates = []
  state.exportJobs = []
  state.auditEvents = []
  state.formSubmissions = []
  state.draftStepStates = []
  state.pendingUploadIntents = []
  state.profiles = []
  state.stageChanges = []
  state.boardVersions = {}
  state.pipelineStagesByFirm = {}
  state.pipelineStages = []
  state.notes = []
  state.documentUploads = []
  state.portalLinks = []
  state.invites = []
  state.notifications = []
  state.authAttempts = []
  state.passwordResetAttempts = []
  state.passwordResets = []
  state.mfaChallenges = []
}

export function loadState(seedFactory) {
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
  if (row?.payload) {
    const state = JSON.parse(row.payload)
    // Legacy blobs mirrored the export queue in state.exportJobs, the audit
    // trail in state.auditEvents, the draft-churn entities in
    // state.formSubmissions/draftStepStates/pendingUploadIntents, and the
    // board entities in state.profiles/stageChanges/boardVersions/
    // pipelineStages, and the client-data entities in state.notes/
    // documentUploads/portalLinks/invites. The relational tables are now the
    // sole sources of truth: seed them once from the blob (old databases whose
    // tables predate the cutover), then strip the mirrors from the blob so
    // they never get written back.
    ensureIdentityEntitiesSeededFromState(state)
    ensureTemplateEntitiesSeededFromState(state)
    ensureQueueSeededFromState(state)
    ensureAuditSeededFromState(state)
    ensureSubmissionEntitiesSeededFromState(state)
    ensureBoardEntitiesSeededFromState(state)
    ensureClientDataEntitiesSeededFromState(state)
    ensureNotificationsSeededFromState(state)
    ensureAuthEntitiesSeededFromState(state)
    const hadBlobMirrors =
      [
        state.firms,
        state.users,
        state.households,
        state.formTemplates,
        state.documentTemplates,
        state.templateAggregates,
        state.exportJobs,
        state.auditEvents,
        state.formSubmissions,
        state.draftStepStates,
        state.pendingUploadIntents,
        state.profiles,
        state.stageChanges,
        state.pipelineStages,
        state.notes,
        state.documentUploads,
        state.portalLinks,
        state.invites,
        state.notifications,
        state.authAttempts,
        state.passwordResetAttempts,
        state.passwordResets,
        state.mfaChallenges
      ].some((entries) => Array.isArray(entries) && entries.length > 0) ||
      [state.boardVersions, state.pipelineStagesByFirm].some(
        (entries) => entries && typeof entries === 'object' && Object.keys(entries).length > 0
      )
    if (hadBlobMirrors) {
      stripRelationalMirrors(state)
      db.prepare(
        `
        INSERT INTO app_state (id, payload, updated_at)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `
      ).run(JSON.stringify(state))
    }
    stripRelationalMirrors(state)
    // Sessions live exclusively in the sessions table (migrations 002/003
    // backfilled and cleared the blob). Keep the array shape for consumers
    // but never surface stale blob sessions.
    state.sessions = []
    return state
  }

  const state = seedFactory()
  saveState(state)
  ensureIdentityEntitiesSeededFromState(state)
  ensureTemplateEntitiesSeededFromState(state)
  ensureQueueSeededFromState(state)
  ensureAuditSeededFromState(state)
  ensureSubmissionEntitiesSeededFromState(state)
  ensureBoardEntitiesSeededFromState(state)
  ensureClientDataEntitiesSeededFromState(state)
  ensureNotificationsSeededFromState(state)
  ensureAuthEntitiesSeededFromState(state)
  stripRelationalMirrors(state)
  state.sessions = []
  return state
}

export function saveState(state) {
  // firms, users, households, form_templates, document_templates,
  // template_aggregates, export_jobs, sessions, audit_events, form_submissions,
  // draft_step_states, pending_upload_intents, profiles, stage_changes,
  // board_versions, pipeline_stage_records, notes, document_uploads,
  // portal_links, and invites are relational sources of truth: the blob keeps
  // empty arrays/maps for them purely for shape compatibility, so a stale
  // in-memory mirror can never clobber targeted relational writes.
  const payload = JSON.stringify({
    ...state,
    firms: [],
    users: [],
    households: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [],
    sessions: [],
    auditEvents: [],
    formSubmissions: [],
    draftStepStates: [],
    pendingUploadIntents: [],
    profiles: [],
    stageChanges: [],
    boardVersions: {},
    pipelineStagesByFirm: {},
    pipelineStages: [],
    notes: [],
    documentUploads: [],
    portalLinks: [],
    invites: [],
    notifications: [],
    authAttempts: [],
    passwordResetAttempts: [],
    passwordResets: [],
    mfaChallenges: []
  })
  // The blob upsert and materialized analytics must commit together: a failure
  // partway through (e.g. mid analytics rebuild) would otherwise leave the blob
  // and the materialized view out of sync. Every relational entity is now a
  // source of truth written by its own targeted upsert, so there are no derived
  // query tables left to resync here — syncQueryTables and its replaceRows
  // helper were retired once the template system (their last consumer) became
  // relational. runInTransaction joins any outer transaction (e.g. a pipeline
  // board transaction), so a persist() inside one commits/rolls back with it.
  runInTransaction(() => {
    db.prepare(
      `
      INSERT INTO app_state (id, payload, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `
    ).run(payload)
    syncAnalyticsMaterialized(state)
  })
}

export function backupState(targetPath = resolve(process.cwd(), 'data', `backup-${Date.now()}.db`)) {
  const resolvedTarget = resolve(targetPath)
  mkdirSync(dirname(resolvedTarget), { recursive: true })
  // VACUUM INTO refuses to overwrite an existing file; remove any prior
  // backup (and stray sidecar files) so the semantics stay "replace".
  rmSync(resolvedTarget, { force: true })
  rmSync(`${resolvedTarget}-wal`, { force: true })
  rmSync(`${resolvedTarget}-shm`, { force: true })
  try {
    // WAL-safe backup: VACUUM INTO writes a consistent, checkpointed snapshot
    // through SQLite itself instead of copying a live file mid-write.
    db.prepare('VACUUM INTO ?').run(resolvedTarget)
  } catch {
    // Fallback for SQLite builds without VACUUM INTO: fold the WAL back into
    // the main database file, then a plain file copy is safe enough.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(DB_PATH, resolvedTarget)
  }
  return { ok: true, targetPath: resolvedTarget }
}

export function enqueueExportJob(job) {
  const idempotencyKey = (job.idempotencyKey || '').trim() || null
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT id FROM export_jobs WHERE firm_id = ? AND idempotency_key = ?')
      .get(job.firmId, idempotencyKey)
    if (existing?.id) {
      return getExportJob(existing.id)
    }
  }
  const createdAt = job.createdAt || nowIso()
  const payload = {
    id: job.id,
    firmId: job.firmId,
    clientId: job.clientId || null,
    templateId: job.templateId || null,
    submissionId: job.submissionId || null,
    createdByUserId: job.createdByUserId || null,
    renderContext: job.renderContext || null,
    type: job.type || 'pdf',
    status: 'queued',
    attempts: 0,
    maxAttempts: Number(job.maxAttempts || 3),
    idempotencyKey,
    output: null,
    createdAt,
    updatedAt: createdAt,
    metadata: job.metadata || {}
  }
  db.prepare(
    `
    INSERT INTO export_jobs (
      id, firm_id, client_id, type, status, attempts, max_attempts, payload, output_payload,
      error_message, next_attempt_at, leased_by, lease_expires_at, created_at, updated_at,
      completed_at, dead_lettered_at, last_attempt_at, idempotency_key
    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)
  `
  ).run(
    payload.id,
    payload.firmId,
    payload.clientId,
    payload.type,
    payload.maxAttempts,
    JSON.stringify(payload),
    createdAt,
    createdAt,
    createdAt,
    idempotencyKey
  )
  return payload
}

export function requeueExportJob(jobId) {
  const existing = db.prepare('SELECT payload FROM export_jobs WHERE id = ?').get(jobId)
  if (!existing) return null
  const timestamp = nowIso()
  const payload = {
    ...(existing.payload ? JSON.parse(existing.payload) : {}),
    status: 'queued',
    attempts: 0,
    errorMessage: null,
    deadLetteredAt: null,
    completedAt: null,
    updatedAt: timestamp
  }
  db.prepare(
    `
    UPDATE export_jobs
    SET status = 'queued',
      attempts = 0,
      error_message = NULL,
      next_attempt_at = ?,
      leased_by = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      dead_lettered_at = NULL,
      updated_at = ?,
      payload = ?
    WHERE id = ?
  `
  ).run(timestamp, timestamp, JSON.stringify(payload), jobId)
  return getExportJob(jobId)
}

export function getExportJob(jobId) {
  return listExportQueueJobs().find((job) => job.id === jobId) || null
}

// Targeted lifecycle update for completed-job artifacts (archive/purge).
// Deliberately leaves updated_at untouched: retention aging is computed from
// updatedAt/createdAt, and bumping it on archive would reset the purge clock.
// The SELECT-then-UPDATE runs inside BEGIN IMMEDIATE so a concurrent export
// worker write (completion/failure payload rewrite) cannot interleave between
// the read and the write and get clobbered by a stale merged payload.
export function applyExportJobLifecycleUpdate(jobId, { status, output } = {}) {
  const found = runInTransaction(() => {
    const existing = db.prepare('SELECT status, payload FROM export_jobs WHERE id = ?').get(jobId)
    if (!existing) return false
    const existingPayload = existing.payload ? JSON.parse(existing.payload) : {}
    const nextStatus = status || existing.status
    const nextOutput = output === undefined ? existingPayload.output || null : output
    const nextPayload = { ...existingPayload, status: nextStatus, output: nextOutput }
    db.prepare(
      `
      UPDATE export_jobs
      SET status = ?, output_payload = ?, payload = ?
      WHERE id = ?
    `
    ).run(nextStatus, JSON.stringify(nextOutput), JSON.stringify(nextPayload), jobId)
    return true
  })
  if (!found) return null
  return getExportJob(jobId)
}

export function leaseExportJobs({ workerId = 'worker', limit = 5, leaseMs = 30_000 } = {}) {
  const nowMs = Date.now()
  const nowText = new Date(nowMs).toISOString()
  const leaseUntil = new Date(nowMs + leaseMs).toISOString()

  const ids = runInTransaction(() => {
    const candidates = db
      .prepare(
        `
      SELECT id
      FROM export_jobs
      WHERE status IN ('queued', 'retrying', 'running')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (
          status != 'running'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= ?
        )
      ORDER BY created_at ASC
      LIMIT ?
    `
      )
      .all(nowText, nowText, limit)

    const candidateIds = candidates.map((row) => row.id)
    if (!candidateIds.length) return []

    const placeholders = candidateIds.map(() => '?').join(',')
    db.prepare(
      `
      UPDATE export_jobs
      SET status = 'running', leased_by = ?, lease_expires_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `
    ).run(workerId, leaseUntil, nowText, ...candidateIds)
    return candidateIds
  })
  return ids.map((id) => getExportJob(id)).filter(Boolean)
}

// Emits a single in-app notification for an export job that reached a terminal
// lifecycle state. Called from markExportJobCompleted / markExportJobFailed, so
// whichever process (API inline tick or standalone worker) finalizes the job
// creates the row. Best-effort: a notification failure must never mask the
// job-state write, so it is swallowed.
function notifyExportLifecycle(job, kind) {
  if (!job || !job.firmId) return
  const shortId = String(job.id || '').slice(0, 8) || 'export'
  const completed = kind === 'completed'
  try {
    insertNotification({
      firmId: job.firmId,
      userId: job.createdByUserId || null,
      type: completed ? 'export.completed' : 'export.failed',
      title: completed ? 'Export ready' : 'Export failed',
      body: completed
        ? `Your ${job.type || 'pdf'} export (${shortId}) finished and is ready to download.`
        : `Your ${job.type || 'pdf'} export (${shortId}) failed. Review it and retry.`,
      link: '/exports',
      entityType: 'export_job',
      entityId: job.id
    })
  } catch {
    // Non-fatal: the export lifecycle write already committed.
  }
}

export function markExportJobCompleted(jobId, output) {
  const existing = db.prepare('SELECT payload FROM export_jobs WHERE id = ?').get(jobId)
  if (!existing) return null
  const timestamp = nowIso()
  const payload = {
    ...(existing.payload ? JSON.parse(existing.payload) : {}),
    status: 'completed',
    output: output || null,
    errorMessage: null,
    completedAt: timestamp,
    updatedAt: timestamp
  }
  db.prepare(
    `
    UPDATE export_jobs
    SET status = 'completed',
      output_payload = ?,
      error_message = NULL,
      leased_by = NULL,
      lease_expires_at = NULL,
      completed_at = ?,
      updated_at = ?,
      payload = ?
    WHERE id = ?
  `
  ).run(JSON.stringify(output || null), timestamp, timestamp, JSON.stringify(payload), jobId)
  notifyExportLifecycle(payload, 'completed')
  return getExportJob(jobId)
}

function classifyFailure(message = '') {
  const normalized = String(message).toLowerCase()
  if (
    normalized.includes('timeout') ||
    normalized.includes('temporar') ||
    normalized.includes('rate limit') ||
    normalized.includes('simulated export failure')
  ) {
    return 'transient'
  }
  if (
    normalized.includes('invalid') ||
    normalized.includes('not found') ||
    normalized.includes('forbidden') ||
    normalized.includes('unauthorized')
  ) {
    return 'permanent'
  }
  return 'manual'
}

export function markExportJobFailed(jobId, errorMessage, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 3)
  const baseBackoffMs = Number(options.baseBackoffMs || 500)
  const maxBackoffMs = Number(options.maxBackoffMs || 30_000)
  const jitterRatio = Math.max(0, Math.min(Number(options.jitterRatio ?? 0.25), 0.75))
  const poisonErrorThreshold = Math.max(2, Number(options.poisonErrorThreshold || 3))
  const workerId = options.workerId || null
  const current = db
    .prepare('SELECT attempts, max_attempts AS maxAttempts, payload FROM export_jobs WHERE id = ?')
    .get(jobId)
  if (!current) return null
  const existingPayload = current.payload ? JSON.parse(current.payload) : {}
  const attempts = Number(current.attempts || 0) + 1
  const effectiveMaxAttempts = Number(current.maxAttempts || maxAttempts)
  const timestamp = nowIso()
  const normalizedError = String(errorMessage || 'Unknown worker failure')
  const previousError = String(existingPayload?.failure?.lastError || '')
  const repeatedErrorCount =
    normalizedError === previousError ? Number(existingPayload?.failure?.repeatedErrorCount || 0) + 1 : 1
  const failureClass = options.failureClass || classifyFailure(normalizedError)
  const poisonDetected = repeatedErrorCount >= poisonErrorThreshold
  const deadLetterNow = failureClass === 'permanent' || attempts >= effectiveMaxAttempts || poisonDetected

  if (deadLetterNow) {
    const deadLetterReason =
      failureClass === 'permanent' ? 'non_retryable_failure' : poisonDetected ? 'poison_job' : 'max_attempts_exhausted'
    const payload = {
      ...existingPayload,
      status: 'dead-letter',
      attempts,
      errorMessage: normalizedError,
      deadLetteredAt: timestamp,
      lastAttemptAt: timestamp,
      updatedAt: timestamp,
      failure: {
        reason: deadLetterReason,
        workerId,
        attempts,
        maxAttempts: effectiveMaxAttempts,
        firstFailedAt: existingPayload?.failure?.firstFailedAt || timestamp,
        lastFailedAt: timestamp,
        lastError: normalizedError,
        repeatedErrorCount,
        poisonDetected,
        classification: failureClass
      }
    }
    db.prepare(
      `
      UPDATE export_jobs
      SET status = 'dead-letter', attempts = ?, error_message = ?, leased_by = NULL,
        lease_expires_at = NULL, dead_lettered_at = ?, last_attempt_at = ?, updated_at = ?, payload = ?
      WHERE id = ?
    `
    ).run(attempts, normalizedError, timestamp, timestamp, timestamp, JSON.stringify(payload), jobId)
    notifyExportLifecycle(payload, 'failed')
  } else if (failureClass === 'transient') {
    const delayBaseMs = Math.min(baseBackoffMs * 2 ** (attempts - 1), maxBackoffMs)
    const jitterMs = Math.round((Math.random() * 2 - 1) * delayBaseMs * jitterRatio)
    const delayMs = Math.max(250, delayBaseMs + jitterMs)
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString()
    const nextFailures = Number(existingPayload?.metadata?.simulateFailuresRemaining || 0)
    const payload = {
      ...existingPayload,
      status: 'retrying',
      attempts,
      errorMessage: normalizedError,
      nextAttemptAt,
      lastAttemptAt: timestamp,
      updatedAt: timestamp,
      failure: {
        reason: 'retry_scheduled',
        workerId,
        attempts,
        maxAttempts: effectiveMaxAttempts,
        firstFailedAt: existingPayload?.failure?.firstFailedAt || timestamp,
        lastFailedAt: timestamp,
        lastError: normalizedError,
        repeatedErrorCount,
        jitterMs,
        nextAttemptAt,
        classification: failureClass
      },
      metadata: {
        ...(existingPayload.metadata || {}),
        simulateFailuresRemaining: Math.max(0, nextFailures - 1)
      }
    }
    db.prepare(
      `
      UPDATE export_jobs
      SET status = 'retrying', attempts = ?, error_message = ?, next_attempt_at = ?, leased_by = NULL,
        lease_expires_at = NULL, last_attempt_at = ?, updated_at = ?, payload = ?
      WHERE id = ?
    `
    ).run(attempts, normalizedError, nextAttemptAt, timestamp, timestamp, JSON.stringify(payload), jobId)
  } else {
    const payload = {
      ...existingPayload,
      status: 'failed',
      attempts,
      errorMessage: normalizedError,
      lastAttemptAt: timestamp,
      updatedAt: timestamp,
      failure: {
        reason: 'retry_required',
        workerId,
        attempts,
        maxAttempts: effectiveMaxAttempts,
        firstFailedAt: existingPayload?.failure?.firstFailedAt || timestamp,
        lastFailedAt: timestamp,
        lastError: normalizedError,
        repeatedErrorCount,
        classification: failureClass
      }
    }
    db.prepare(
      `
      UPDATE export_jobs
      SET status = 'failed', attempts = ?, error_message = ?, leased_by = NULL,
        lease_expires_at = NULL, last_attempt_at = ?, updated_at = ?, payload = ?
      WHERE id = ?
    `
    ).run(attempts, normalizedError, timestamp, timestamp, JSON.stringify(payload), jobId)
    notifyExportLifecycle(payload, 'failed')
  }

  return getExportJob(jobId)
}

export function processExportQueueTick({ workerId = 'worker', limit = 5, leaseMs = 30_000, processor, onLeased } = {}) {
  const startedAt = Date.now()
  const stalledJobs = listExportQueueJobs().filter((job) => {
    if (job.status !== 'running' || !job.leaseExpiresAt) return false
    return Number(new Date(job.leaseExpiresAt)) <= startedAt
  })
  let timedOutRecovered = 0
  for (const stalledJob of stalledJobs) {
    markExportJobFailed(stalledJob.id, `Export lease timed out for job ${stalledJob.id}`, {
      maxAttempts: stalledJob.maxAttempts || 3,
      workerId,
      failureClass: 'transient'
    })
    timedOutRecovered += 1
  }
  const leased = leaseExportJobs({ workerId, limit, leaseMs })
  onLeased?.(leased)
  let processed = 0
  let failed = 0
  let skipped = 0

  for (const job of leased) {
    const current = getExportJob(job.id)
    if (current?.status === 'completed' || current?.status === 'dead-letter') {
      skipped += 1
      continue
    }
    try {
      const output = processor?.({
        ...job,
        execution: {
          idempotencyKey: job.idempotencyKey || job.id,
          workerId,
          leasedAt: new Date(startedAt).toISOString(),
          leaseMs
        }
      })
      markExportJobCompleted(job.id, output)
      processed += 1
    } catch (error) {
      markExportJobFailed(job.id, error?.message || String(error), {
        maxAttempts: job.maxAttempts || 3,
        workerId,
        failureClass: error?.failureClass || null
      })
      failed += 1
    }
  }

  return {
    leased: leased.length,
    processed,
    failed,
    skipped,
    timedOutRecovered,
    durationMs: Date.now() - startedAt,
    timestamp: nowIso()
  }
}

export function recordExportWorkerHeartbeat(workerId, payload = {}) {
  const normalizedWorkerId = String(workerId || 'worker').trim() || 'worker'
  const timestamp = nowIso()
  const existing = db
    .prepare('SELECT started_at AS startedAt FROM export_worker_heartbeats WHERE worker_id = ?')
    .get(normalizedWorkerId)
  db.prepare(
    `
    INSERT INTO export_worker_heartbeats (worker_id, started_at, last_heartbeat_at, mode, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET
      last_heartbeat_at = excluded.last_heartbeat_at,
      mode = excluded.mode,
      payload = excluded.payload
  `
  ).run(
    normalizedWorkerId,
    existing?.startedAt || timestamp,
    timestamp,
    String(payload.mode || 'companion'),
    JSON.stringify({ ...payload, workerId: normalizedWorkerId, lastHeartbeatAt: timestamp })
  )
  return { workerId: normalizedWorkerId, startedAt: existing?.startedAt || timestamp, lastHeartbeatAt: timestamp }
}

export function readExportWorkerHeartbeat({ staleAfterMs = 30_000 } = {}) {
  const rows = db
    .prepare(
      `
    SELECT worker_id AS workerId, started_at AS startedAt, last_heartbeat_at AS lastHeartbeatAt, mode, payload
    FROM export_worker_heartbeats
    ORDER BY last_heartbeat_at DESC
  `
    )
    .all()
  const workers = rows.map((row) => {
    let payload = {}
    try {
      payload = row.payload ? JSON.parse(row.payload) : {}
    } catch {
      payload = {}
    }
    const ageMs = Math.max(0, Date.now() - Number(new Date(row.lastHeartbeatAt || 0)))
    return {
      ...payload,
      workerId: row.workerId,
      startedAt: row.startedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      mode: row.mode || payload.mode || 'companion',
      ageMs,
      observedRecently: ageMs <= staleAfterMs
    }
  })
  const latest = workers[0] || null
  return {
    workerMode: 'companion',
    manualProcessEndpointDeprecated: true,
    lastWorkerHeartbeatAt: latest?.lastHeartbeatAt || null,
    workerObservedRecently: latest?.observedRecently === true,
    staleAfterMs,
    workers
  }
}

export async function processExportQueueTickAsync({
  workerId = 'worker',
  limit = 5,
  leaseMs = 30_000,
  processor,
  onLeased
} = {}) {
  const startedAt = Date.now()
  const stalledJobs = listExportQueueJobs().filter((job) => {
    if (job.status !== 'running' || !job.leaseExpiresAt) return false
    return Number(new Date(job.leaseExpiresAt)) <= startedAt
  })
  let timedOutRecovered = 0
  for (const stalledJob of stalledJobs) {
    markExportJobFailed(stalledJob.id, `Export lease timed out for job ${stalledJob.id}`, {
      maxAttempts: stalledJob.maxAttempts || 3,
      workerId,
      failureClass: 'transient'
    })
    timedOutRecovered += 1
  }
  const leased = leaseExportJobs({ workerId, limit, leaseMs })
  await onLeased?.(leased)
  let processed = 0
  let failed = 0
  let skipped = 0

  for (const job of leased) {
    const current = getExportJob(job.id)
    if (current?.status === 'completed' || current?.status === 'dead-letter') {
      skipped += 1
      continue
    }
    try {
      const output = await processor?.({
        ...job,
        execution: {
          idempotencyKey: job.idempotencyKey || job.id,
          workerId,
          leasedAt: new Date(startedAt).toISOString(),
          leaseMs
        }
      })
      markExportJobCompleted(job.id, output)
      processed += 1
    } catch (error) {
      markExportJobFailed(job.id, error?.message || String(error), {
        maxAttempts: job.maxAttempts || 3,
        workerId,
        failureClass: error?.failureClass || null
      })
      failed += 1
    }
  }

  return {
    leased: leased.length,
    processed,
    failed,
    skipped,
    timedOutRecovered,
    durationMs: Date.now() - startedAt,
    timestamp: nowIso()
  }
}

export function readQuerySummary() {
  return {
    firms: db.prepare('SELECT COUNT(*) AS count FROM firms').get().count,
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    profiles: db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,
    households: db.prepare('SELECT COUNT(*) AS count FROM households').get().count,
    templates: db.prepare('SELECT COUNT(*) AS count FROM document_templates').get().count,
    exports: db.prepare('SELECT COUNT(*) AS count FROM export_jobs').get().count
  }
}

export function readExportWorkerStatus() {
  const statuses = db
    .prepare(
      `
    SELECT status, COUNT(*) AS count
    FROM export_jobs
    GROUP BY status
  `
    )
    .all()
  const byStatus = Object.fromEntries(statuses.map((row) => [row.status, row.count]))
  const latest = db
    .prepare(
      `
    SELECT payload
    FROM export_jobs
    ORDER BY updated_at DESC
    LIMIT 1
  `
    )
    .get()
  const activeLeases = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM export_jobs
    WHERE status = 'running' AND lease_expires_at > ?
  `
    )
    .get(nowIso()).count
  const retryCounts = db
    .prepare(
      `
    SELECT attempts, COUNT(*) AS count
    FROM export_jobs
    WHERE status = 'retrying'
    GROUP BY attempts
    ORDER BY attempts ASC
  `
    )
    .all()
  const deadLetter = db.prepare("SELECT COUNT(*) AS count FROM export_jobs WHERE status = 'dead-letter'").get().count
  const readyNow = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM export_jobs
    WHERE status IN ('queued', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  `
    )
    .get(nowIso()).count
  const stalled = db
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM export_jobs
    WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `
    )
    .get(nowIso()).count

  const heartbeat = readExportWorkerHeartbeat()
  const pending = (byStatus.queued || 0) + (byStatus.retrying || 0)
  return {
    queued: (byStatus.queued || 0) + (byStatus.retrying || 0),
    running: byStatus.running || 0,
    processing: byStatus.running || 0,
    completed: byStatus.completed || 0,
    failed: byStatus.failed || 0,
    deadLetter,
    readyNow,
    stalled,
    total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    activeLeases,
    retryCounts,
    byStatus,
    latestJob: latest?.payload ? JSON.parse(latest.payload) : null,
    workerMode: heartbeat.workerMode,
    manualProcessEndpointDeprecated: heartbeat.manualProcessEndpointDeprecated,
    lastWorkerHeartbeatAt: heartbeat.lastWorkerHeartbeatAt,
    workerObservedRecently: heartbeat.workerObservedRecently,
    pendingWithoutWorker: pending > 0 && !heartbeat.workerObservedRecently,
    workerHeartbeat: heartbeat
  }
}

export function readStorageHealth() {
  const now = Date.now()
  const info = {
    dbPath: DB_PATH,
    exists: existsSync(DB_PATH),
    sizeBytes: 0,
    quickCheck: 'unknown',
    connected: false,
    latencyMs: 0,
    ok: false
  }
  if (info.exists) {
    info.sizeBytes = statSync(DB_PATH).size
  }
  db.prepare('SELECT 1').get()
  info.connected = true
  const quickCheck = db.prepare('PRAGMA quick_check').get()
  info.quickCheck = quickCheck?.quick_check || 'unknown'
  info.latencyMs = Date.now() - now
  info.ok = Boolean(info.connected && info.quickCheck === 'ok')
  return info
}

export function readAuditEventSummary() {
  const row = db.prepare('SELECT COUNT(*) AS total FROM audit_events').get()
  const last = db
    .prepare(
      `
    SELECT occurred_at AS occurredAt, action
    FROM audit_events
    ORDER BY occurred_at DESC
    LIMIT 1
  `
    )
    .get()
  return {
    total: row?.total || 0,
    latest: last || null
  }
}

export function readAnalyticsMaterializedSummary(firmId) {
  const row = db
    .prepare(
      `
    SELECT payload, updated_at AS updatedAt
    FROM analytics_materialized
    WHERE firm_id = ?
  `
    )
    .get(firmId)
  if (!row) return null
  return { ...JSON.parse(row.payload), updatedAt: row.updatedAt }
}
