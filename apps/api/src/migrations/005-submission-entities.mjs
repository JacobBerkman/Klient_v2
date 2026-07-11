// Form submissions, portal draft section states, and pending upload intents
// move out of the app_state blob into relational tables as sources of truth.
// These are the highest-churn entities after sessions and audit events: every
// portal draft save, optimistic section-state write, and upload presign used
// to rewrite the entire blob. From this version on the store performs
// targeted single-row reads/writes against these tables and the blob
// serializes empty arrays for the three keys purely for shape compatibility.
//
// Table design mirrors export_jobs/audit_events: the canonical record lives
// in the payload JSON column; hot columns (ids, tenancy, status, timestamps,
// and the section-state version used for optimistic concurrency) are promoted
// for keying, scoped queries, and row-level guards.
//
// This migration creates the tables, backfills them from any remaining blob
// arrays (keyed INSERT OR IGNORE), and clears the arrays out of the blob with
// a targeted payload update.
//
// Idempotent: CREATE TABLE IF NOT EXISTS, keyed INSERT OR IGNORE, and the
// blob rewrite only happens when at least one of the arrays is non-empty.
import { randomUUID } from 'node:crypto'

export default {
  version: 5,
  name: 'submission-entities-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS form_submissions (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    template_id TEXT,
    status TEXT,
    source TEXT,
    created_by_user_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_form_submissions_firm_client ON form_submissions (firm_id, client_id);
  CREATE INDEX IF NOT EXISTS idx_form_submissions_firm_template ON form_submissions (firm_id, template_id);

  CREATE TABLE IF NOT EXISTS draft_step_states (
    firm_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (firm_id, client_id, draft_id, section_id)
  );

  CREATE INDEX IF NOT EXISTS idx_draft_step_states_firm_client ON draft_step_states (firm_id, client_id);

  CREATE TABLE IF NOT EXISTS pending_upload_intents (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    expires_at TEXT,
    created_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending_upload_intents_firm_client ON pending_upload_intents (firm_id, client_id);
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

    const submissions = Array.isArray(parsed?.formSubmissions) ? parsed.formSubmissions : []
    const sectionStates = Array.isArray(parsed?.draftStepStates) ? parsed.draftStepStates : []
    const uploadIntents = Array.isArray(parsed?.pendingUploadIntents) ? parsed.pendingUploadIntents : []
    if (submissions.length === 0 && sectionStates.length === 0 && uploadIntents.length === 0) return

    const insertSubmission = db.prepare(`
      INSERT OR IGNORE INTO form_submissions (
        id, firm_id, client_id, template_id, status, source, created_by_user_id, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const submission of submissions) {
      if (!submission || typeof submission !== 'object') continue
      insertSubmission.run(
        submission.id || randomUUID(),
        // firm_id is NOT NULL; unattributed records bucket under 'unknown'
        // and never match a real firm's scoped reads.
        submission.firmId ?? 'unknown',
        submission.clientId ?? null,
        submission.templateId ?? null,
        submission.status ?? null,
        submission.source ?? null,
        submission.createdByUserId ?? null,
        submission.createdAt ?? null,
        submission.updatedAt ?? submission.createdAt ?? null,
        JSON.stringify(submission)
      )
    }

    // Section-state payload holds the section data object; identity, version,
    // and updated_at are all promoted columns (version drives the optimistic
    // UPDATE ... WHERE version = ? guard).
    const insertSectionState = db.prepare(`
      INSERT OR IGNORE INTO draft_step_states (firm_id, client_id, draft_id, section_id, version, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const entry of sectionStates) {
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
    for (const intent of uploadIntents) {
      if (!intent || typeof intent !== 'object') continue
      insertIntent.run(
        intent.id || randomUUID(),
        intent.firmId ?? 'unknown',
        intent.clientId ?? null,
        intent.expiresAt ?? null,
        intent.createdAt ?? null,
        JSON.stringify(intent)
      )
    }

    parsed.formSubmissions = []
    parsed.draftStepStates = []
    parsed.pendingUploadIntents = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
