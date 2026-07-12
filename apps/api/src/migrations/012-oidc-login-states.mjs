// Google OIDC interactive sign-in needs a short-lived, single-use server-side
// record for each in-flight Authorization Code + PKCE login. It carries the
// CSRF/replay defenses that must never leave the server:
//   - state:         opaque one-time value echoed back on the callback (the
//                    CSRF defense for the GET callback, which has no CSRF token)
//   - code_verifier: the PKCE (S256) verifier; the code_challenge derived from it
//                    was sent to Google, and the verifier is presented at token
//                    exchange. It MUST stay server-side.
//   - nonce:         bound into the authorization request and asserted against
//                    the id_token `nonce` claim to defeat token replay.
//
// This mirrors the ephemeral one-time-token tables introduced in migration 008
// (password_resets / mfa_challenges): columns-only, small and flat, with expiry
// enforced by comparing expires_at against now, and single-use enforced by a
// used_at stamp. Rows are pruned on insert and on consume, so the table stays
// tiny. There is nothing to backfill — this is a brand-new capability, disabled
// unless GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are configured.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only.
export default {
  version: 12,
  name: 'oidc-login-states',
  up(db) {
    db.exec(`
  CREATE TABLE IF NOT EXISTS oidc_login_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_oidc_login_states_expires ON oidc_login_states (expires_at);
`)
  }
}
