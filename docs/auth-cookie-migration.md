# Auth session cookie migration (temporary bearer compatibility)

The API now authenticates web flows with the `__Host-klient-session` cookie and no longer returns reusable bearer tokens by default from:

- `POST /api/login`
- `POST /api/register`
- `POST /api/invites/accept`

## Temporary compatibility shim

For non-browser callers that still require bearer-based flows, send:

- `x-klient-auth-compat: bearer`

When that header is present **and** `ENABLE_BEARER_AUTH_COMPAT=true`, auth responses include the legacy `token` field and deprecation headers.

## Deprecation timeline

- Compatibility mode sunset target: **June 30, 2026**
- Follow-up task: remove `ENABLE_BEARER_AUTH_COMPAT` fallback and `x-klient-auth-compat` header handling.
