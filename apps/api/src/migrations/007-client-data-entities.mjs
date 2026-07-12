// Notes, document uploads, portal links, and invites move out of the app_state
// blob into relational tables as sources of truth. These are the firm-owned
// client-data entities: profile notes, uploaded documents (with their object
// metadata + retention lifecycle), portal share links, and pending user
// invites. From this version on the store performs targeted single-row
// reads/writes against these tables and the blob serializes empty arrays for
// the four keys purely for shape compatibility.
//
// notes already had a table (the 001 baseline), but before this migration it
// was a derived projection destructively rebuilt from the blob on every
// saveState. From this version on the notes table is the sole source of truth
// (written by upsertNoteRow, never a blob resync); document_uploads,
// portal_links, and invites are new tables created here.
//
// Table design mirrors form_submissions/audit_events: the canonical record
// lives in the payload JSON column (round-tripped byte-exact — notes carry an
// encrypted bodyEncrypted envelope, uploads carry object{bucket,key,checksum}
// and malwareScan), and hot columns (ids, tenancy, status, lookup tokens) are
// promoted for keying and scoped queries. token columns are UNIQUE because
// portal access and invite acceptance gate on a single-token lookup.
//
// This migration creates the tables, backfills them from any remaining blob
// arrays (keyed INSERT OR IGNORE — idempotent against the notes rows the old
// projection already left behind), and clears the arrays out of the blob with
// a targeted payload update.
//
// Idempotent: CREATE TABLE IF NOT EXISTS, keyed INSERT OR IGNORE, and the blob
// rewrite only happens when at least one of the four arrays is non-empty.
import { randomUUID } from 'node:crypto'

export default {
  version: 7,
  name: 'client-data-entities-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_firm_profile ON notes (firm_id, profile_id);

  CREATE TABLE IF NOT EXISTS document_uploads (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    client_id TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_document_uploads_firm_client ON document_uploads (firm_id, client_id);
  CREATE INDEX IF NOT EXISTS idx_document_uploads_firm_status ON document_uploads (firm_id, status);

  CREATE TABLE IF NOT EXISTS portal_links (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    profile_id TEXT,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_portal_links_firm ON portal_links (firm_id);

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    email TEXT,
    role TEXT,
    created_at TEXT,
    expires_at TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_invites_firm ON invites (firm_id);
  CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (firm_id, email);
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

    const notes = Array.isArray(parsed?.notes) ? parsed.notes : []
    const documentUploads = Array.isArray(parsed?.documentUploads) ? parsed.documentUploads : []
    const portalLinks = Array.isArray(parsed?.portalLinks) ? parsed.portalLinks : []
    const invites = Array.isArray(parsed?.invites) ? parsed.invites : []
    if (notes.length === 0 && documentUploads.length === 0 && portalLinks.length === 0 && invites.length === 0) {
      return
    }

    // notes: firm_id/profile_id/created_at promoted; the full note object
    // (including any encrypted bodyEncrypted envelope) is preserved verbatim.
    const insertNote = db.prepare(`
      INSERT OR IGNORE INTO notes (id, firm_id, profile_id, created_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const note of notes) {
      if (!note || typeof note !== 'object') continue
      insertNote.run(
        note.id || randomUUID(),
        // firm_id is NOT NULL; unattributed records bucket under 'unknown'
        // and never match a real firm's scoped reads.
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
    for (const upload of documentUploads) {
      if (!upload || typeof upload !== 'object') continue
      insertUpload.run(
        upload.id || randomUUID(),
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
    for (const link of portalLinks) {
      if (!link || typeof link !== 'object' || !link.token) continue
      insertPortalLink.run(
        link.id || randomUUID(),
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
    for (const invite of invites) {
      if (!invite || typeof invite !== 'object' || !invite.token) continue
      insertInvite.run(
        invite.id || randomUUID(),
        invite.firmId ?? 'unknown',
        invite.token,
        invite.email ?? null,
        invite.role ?? null,
        invite.createdAt ?? null,
        invite.expiresAt ?? null,
        JSON.stringify(invite)
      )
    }

    parsed.notes = []
    parsed.documentUploads = []
    parsed.portalLinks = []
    parsed.invites = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
