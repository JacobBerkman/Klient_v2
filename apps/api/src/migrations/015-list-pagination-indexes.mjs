// Keyset-pagination covering indexes for the opt-in paged list endpoints
// (GET /api/profiles|/api/households|/api/forms/templates|/api/forms/submissions
// with limit/cursor). Every index is over promoted plaintext columns only —
// SSN/DOB live exclusively inside the encrypted payload JSON and are NEVER
// indexed.
//
// form_submissions already has (firm_id, client_id) and (firm_id, template_id)
// from migration 005; the (firm_id, created_at) index added here backs the
// created_at DESC, rowid DESC page ordering.
//
// Idempotent: CREATE INDEX IF NOT EXISTS throughout.
export default {
  version: 15,
  name: 'list-pagination-indexes',
  up(db) {
    db.exec(`
  CREATE INDEX IF NOT EXISTS idx_profiles_firm_name_page
    ON profiles (firm_id, last_name COLLATE NOCASE, first_name COLLATE NOCASE, id);

  CREATE INDEX IF NOT EXISTS idx_households_firm_name_page
    ON households (firm_id, name COLLATE NOCASE, id);

  CREATE INDEX IF NOT EXISTS idx_form_submissions_firm_created
    ON form_submissions (firm_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_template_aggregates_firm_name_page
    ON template_aggregates (firm_id, name COLLATE NOCASE, id);
`)
  }
}
