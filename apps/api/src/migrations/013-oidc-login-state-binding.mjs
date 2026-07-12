// Bind each in-flight Google OIDC login to the initiating browser to close a
// CSRF/login-forgery gap: the single-use `state` alone does not prove the
// callback lands in the SAME browser that started the flow. At /start we now set
// a short-lived, httpOnly, SameSite=Lax binding cookie carrying a random token
// and persist ITS HASH here; at the callback the cookie's token must hash to this
// value before the login completes. The raw token never touches the DB (only its
// SHA-256), mirroring how code_verifier/nonce secrets are handled.
//
// migration 012 created oidc_login_states with fixed columns and no JSON payload,
// so the hash needs its own column — added here. Nullable so any row minted
// before this migration (there is no persisted long-lived data; these rows are
// ephemeral and pruned) simply carries no binding and is treated as unbound.
//
// Idempotent: skip the ADD COLUMN when the column already exists.
export default {
  version: 13,
  name: 'oidc-login-state-binding',
  up(db) {
    const columns = db.prepare('PRAGMA table_info(oidc_login_states)').all()
    const hasBindingHash = columns.some((column) => column.name === 'binding_hash')
    if (!hasBindingHash) {
      db.exec('ALTER TABLE oidc_login_states ADD COLUMN binding_hash TEXT;')
    }
  }
}
