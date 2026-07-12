// The TEMPLATE system — form templates, document (PDF) templates, and the
// unified template aggregates (the mapper / publish source) — moves out of the
// app_state blob and becomes the sole source of truth in its own relational
// tables. These three tables already exist from the 001 baseline, but until
// this migration they were DERIVED PROJECTIONS: syncQueryTables destructively
// rebuilt them from the blob arrays (via replaceRows) on every saveState. From
// this version on the tables are authoritative — written by targeted upserts
// (upsertTemplateAggregateRow / upsertFormTemplateRow / upsertDocumentTemplateRow)
// — and the blob serializes empty arrays for the three keys purely for shape
// compatibility. This is the LAST projection cutover of the persistence series:
// once these leave the blob, syncQueryTables has no remaining consumers and is
// deleted along with the replaceRows helper.
//
// template_aggregates is the canonical source: the store keeps an in-memory
// working set hydrated from this table at boot, and every mutation site
// (create, update, mapping edits, PDF-layout edits, lifecycle/publish
// transitions, version revert, auto-build linkage) upserts the row. form_templates
// and document_templates are companion projection tables kept in sync through
// the same mutation path (each row's payload is the adapter view of its
// aggregate), so the readQuerySummary document-template count still works.
//
// Table design reuses the baseline columns exactly (form_templates:
// id/firm_id/name; document_templates: id/firm_id/name/status;
// template_aggregates: id/firm_id/name/kind/publish_state) plus the payload
// JSON column that already backed the projection, so the canonical object
// round-trips byte-exact (aggregate payloads carry blueprint/mappings/pdfLayout/
// versions/publishTransitions verbatim).
//
// This migration promotes any missing payload column (a no-op on the baseline
// schema, which already has it), backfills the three tables from any remaining
// blob arrays (keyed INSERT OR IGNORE — idempotent against the rows the old
// projection already left behind), and clears the arrays out of the blob with a
// targeted payload update.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS, defensive ADD COLUMN
// guarded by a PRAGMA check, keyed INSERT OR IGNORE, and the blob rewrite only
// happens when at least one of the three arrays is non-empty.

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
  version: 10,
  name: 'template-entities-source-of-truth',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS form_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_form_templates_firm ON form_templates (firm_id);

  CREATE TABLE IF NOT EXISTS document_templates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_document_templates_firm ON document_templates (firm_id);

  CREATE TABLE IF NOT EXISTS template_aggregates (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    publish_state TEXT,
    payload TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_template_aggregates_firm ON template_aggregates (firm_id);
`)

    ensurePayloadColumn(db, 'form_templates')
    ensurePayloadColumn(db, 'document_templates')
    ensurePayloadColumn(db, 'template_aggregates')

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

    const formTemplates = Array.isArray(parsed?.formTemplates) ? parsed.formTemplates : []
    const documentTemplates = Array.isArray(parsed?.documentTemplates) ? parsed.documentTemplates : []
    const templateAggregates = Array.isArray(parsed?.templateAggregates) ? parsed.templateAggregates : []
    if (formTemplates.length === 0 && documentTemplates.length === 0 && templateAggregates.length === 0) {
      return
    }

    // form_templates: name promoted; the full projection object (sections,
    // description, generation metadata) is preserved verbatim in payload.
    const insertForm = db.prepare(`
      INSERT OR IGNORE INTO form_templates (id, firm_id, name, payload)
      VALUES (?, ?, ?, ?)
    `)
    for (const template of formTemplates) {
      if (!template || typeof template !== 'object' || !template.id) continue
      insertForm.run(template.id, template.firmId ?? 'unknown', template.name ?? '', JSON.stringify(template))
    }

    // document_templates: name/status promoted; the full projection object
    // (blueprint, mappings, extraction, pdfLayout, versions) is preserved.
    const insertDocument = db.prepare(`
      INSERT OR IGNORE INTO document_templates (id, firm_id, name, status, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const template of documentTemplates) {
      if (!template || typeof template !== 'object' || !template.id) continue
      insertDocument.run(
        template.id,
        template.firmId ?? 'unknown',
        template.name ?? '',
        template.status ?? 'draft',
        JSON.stringify(template)
      )
    }

    // template_aggregates: name/kind/publish_state promoted; the canonical
    // aggregate (blueprint, mappings, pdfLayout, versions, publishTransitions)
    // is preserved verbatim in payload.
    const insertAggregate = db.prepare(`
      INSERT OR IGNORE INTO template_aggregates (id, firm_id, name, kind, publish_state, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const template of templateAggregates) {
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

    parsed.formTemplates = []
    parsed.documentTemplates = []
    parsed.templateAggregates = []
    db.prepare("UPDATE app_state SET payload = ?, updated_at = datetime('now') WHERE id = 1").run(
      JSON.stringify(parsed)
    )
  }
}
