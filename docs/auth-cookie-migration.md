# Auth session cookie migration (completed)

Session-cookie authentication is now the only user-session path. The API authenticates web flows with the `__Host-klient-session` cookie and does **not** emit reusable bearer tokens from:

- `POST /api/login`
- `POST /api/register`
- `POST /api/invites/accept`

## Current behavior

- Auth responses include user profile + CSRF bootstrap metadata.
- Auth responses no longer include a legacy `token` field.
- Session continuity must be driven by the `__Host-klient-session` cookie.
- Operator automation remains bearer-based only for `KLIENT_OPS_TOKEN` on `/api/ops/*` endpoints.
