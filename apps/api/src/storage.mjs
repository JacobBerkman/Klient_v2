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

function replaceRows(tableName, rows, mapper) {
  db.exec(`DELETE FROM ${tableName}`)
  for (const row of rows) {
    const mapped = mapper(row)
    const placeholders = mapped.map(() => '?').join(', ')
    db.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`).run(...mapped)
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

function syncQueryTables(state) {
  replaceRows('firms', state.firms || [], (firm) => [firm.id, firm.name, firm.slug, JSON.stringify(firm)])
  replaceRows('users', state.users || [], (user) => [user.id, user.firmId, user.email, user.role, JSON.stringify(user)])
  replaceRows('profiles', state.profiles || [], (profile) => [
    profile.id,
    profile.firmId,
    profile.kind,
    profile.firstName,
    profile.lastName,
    profile.email || null,
    profile.phone || null,
    profile.status || null,
    profile.stage || null,
    profile.stageOrderIndex || null,
    profile.orderIndex ?? profile.stageOrderIndex ?? null,
    profile.source?.cityOrLocation || null,
    profile.source?.venue || null,
    profile.source?.occurredOn || null,
    profile.householdId || null,
    profile.spouseClientId || null,
    Number(profile.financialSummary?.investableAssets || 0),
    Number(profile.financialSummary?.annualIncome || 0),
    Number(profile.financialSummary?.totalAssets || 0),
    Number(profile.financialSummary?.totalLiabilities || 0),
    Number(profile.financialSummary?.netWorth || 0),
    JSON.stringify(profile.extensions || {}),
    JSON.stringify(profile)
  ])
  replaceRows('households', state.households || [], (household) => [
    household.id,
    household.firmId,
    household.name,
    JSON.stringify(household)
  ])
  replaceRows('form_templates', state.formTemplates || [], (template) => [
    template.id,
    template.firmId,
    template.name,
    JSON.stringify(template)
  ])
  replaceRows('document_templates', state.documentTemplates || [], (template) => [
    template.id,
    template.firmId,
    template.name,
    template.status || 'draft',
    JSON.stringify(template)
  ])
  replaceRows('template_aggregates', state.templateAggregates || [], (template) => [
    template.id,
    template.firmId,
    template.name,
    template.kind || 'document',
    template.publishState || 'draft',
    JSON.stringify(template)
  ])
  replaceRows('notes', state.notes || [], (note) => [
    note.id,
    note.firmId,
    note.profileId,
    note.createdAt,
    JSON.stringify(note)
  ])
  // audit_events is deliberately absent: it is an append-only source of truth
  // written by insertAuditEvent, never a destructive resync from blob state.
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

function syncAnalyticsMaterialized(state) {
  db.exec('DELETE FROM analytics_materialized')
  const firms = state.firms || []
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
  ;(state.profiles || []).forEach((profile) => {
    const summary = byFirm.get(profile.firmId)
    if (!summary || profile.kind !== 'prospect') return
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
  ;(state.formSubmissions || []).forEach((submission) => {
    const summary = byFirm.get(submission.firmId)
    if (!summary) return
    const key = submission.templateId || 'unknown'
    const bucket = summary.formCompletionRates[key] || { templateId: key, drafts: 0, submitted: 0 }
    if (submission.status === 'submitted') bucket.submitted += 1
    else bucket.drafts += 1
    summary.formCompletionRates[key] = bucket
  })

  const usersById = new Map((state.users || []).map((user) => [user.id, user]))
  ;(state.notes || []).forEach((note) => {
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
  ;(state.stageChanges || []).forEach((change) => {
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

export function loadState(seedFactory) {
  const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get()
  if (row?.payload) {
    const state = JSON.parse(row.payload)
    // Legacy blobs mirrored the export queue in state.exportJobs and the
    // audit trail in state.auditEvents. The export_jobs and audit_events
    // tables are now the sole sources of truth: seed them once from the blob
    // (old databases whose tables predate the cutover), then strip the
    // mirrors from the blob so they never get written back.
    ensureQueueSeededFromState(state)
    ensureAuditSeededFromState(state)
    const hadExportJobs = Array.isArray(state.exportJobs) && state.exportJobs.length > 0
    const hadAuditEvents = Array.isArray(state.auditEvents) && state.auditEvents.length > 0
    if (hadExportJobs || hadAuditEvents) {
      state.exportJobs = []
      state.auditEvents = []
      db.prepare(
        `
        INSERT INTO app_state (id, payload, updated_at)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `
      ).run(JSON.stringify(state))
    }
    state.exportJobs = []
    state.auditEvents = []
    // Sessions live exclusively in the sessions table (migrations 002/003
    // backfilled and cleared the blob). Keep the array shape for consumers
    // but never surface stale blob sessions.
    state.sessions = []
    return state
  }

  const state = seedFactory()
  saveState(state)
  ensureQueueSeededFromState(state)
  ensureAuditSeededFromState(state)
  state.exportJobs = []
  state.auditEvents = []
  state.sessions = []
  return state
}

export function saveState(state) {
  // export_jobs, sessions, and audit_events are relational sources of truth:
  // the blob keeps empty arrays for them purely for shape compatibility, so a
  // stale in-memory mirror can never clobber targeted relational writes.
  const payload = JSON.stringify({ ...state, exportJobs: [], sessions: [], auditEvents: [] })
  // The blob upsert, derived query tables, and materialized analytics must
  // commit together: a failure partway through (e.g. mid replaceRows) would
  // otherwise leave the blob and the relational projections out of sync.
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `
      INSERT INTO app_state (id, payload, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `
    ).run(payload)
    syncQueryTables(state)
    syncAnalyticsMaterialized(state)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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
export function applyExportJobLifecycleUpdate(jobId, { status, output } = {}) {
  const existing = db.prepare('SELECT status, payload FROM export_jobs WHERE id = ?').get(jobId)
  if (!existing) return null
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
  return getExportJob(jobId)
}

export function leaseExportJobs({ workerId = 'worker', limit = 5, leaseMs = 30_000 } = {}) {
  const nowMs = Date.now()
  const nowText = new Date(nowMs).toISOString()
  const leaseUntil = new Date(nowMs + leaseMs).toISOString()

  db.exec('BEGIN IMMEDIATE')
  try {
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

    const ids = candidates.map((row) => row.id)
    if (!ids.length) {
      db.exec('COMMIT')
      return []
    }

    const placeholders = ids.map(() => '?').join(',')
    db.prepare(
      `
      UPDATE export_jobs
      SET status = 'running', leased_by = ?, lease_expires_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `
    ).run(workerId, leaseUntil, nowText, ...ids)

    db.exec('COMMIT')
    return ids.map((id) => getExportJob(id)).filter(Boolean)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
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
