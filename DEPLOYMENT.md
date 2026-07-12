# Deployment

## Canonical runtime

Deploy the application by running the single Node server at `apps/api/src/server.mjs`.

Node runtime policy: production containers track the active Node.js **LTS major** (currently 22) and pin an immutable base-image digest for reproducible builds.
This deployment remains a single-process **Node + SQLite + static web** architecture:

- the Node process serves the JSON API,
- SQLite persists runtime data in `data/app.db`,
- canonical React/Vite assets are built from `apps/web/src` into `apps/web/dist` during CI/Docker image creation,
- and the backend serves `apps/web/dist` as the only web shell for all product routes including `/portal`.

`apps/web/dist` is generated build output and is **not committed to git** (it is gitignored). On a fresh clone, run `npm run web:build` before serving the app directly with Node; until you do, the backend has no web shell and static routes return 404. Docker image builds and the CI/`validate:master` gates build `apps/web/dist` themselves, so no pre-built assets are ever required from the repository.

## Environment contract

Copy `.env.example` to `.env` and set the runtime-required production variables.

```bash
NODE_ENV=production
APP_SECRET=replace-with-a-long-random-secret
AUTH_PROVIDER=local
KLIENT_OPS_TOKEN_ACTIVE=replace-with-24-plus-char-ops-token-active
PII_KEY_PROVIDER=env
PII_ACTIVE_KEY_ID=app-key-v1
PII_KEYRING={"app-key-v1":"plain:replace-with-32-byte-base64-or-hex-key"}
```

### Production runtime-required variables (exactly enforced)

| Variable                                                                                        | Required when                                                         | Runtime enforcement                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                                                                    | always in production                                                  | must be explicitly set and meet minimum strength requirements.                                                                                 |
| `AUTH_PROVIDER`                                                                                 | always in production                                                  | must be explicitly set (`local`, `oidc`, or `saml`); `local` is fully supported; `oidc`/`saml` are config-validated but not yet implemented.   |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`                  | `AUTH_PROVIDER=oidc`                                                  | all required; issuer + redirect must be HTTPS; client secret must be >= 16 chars. (not yet implemented; do not select for production)          |
| `SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_CERT`                                                  | `AUTH_PROVIDER=saml`                                                  | all required; entry point must be HTTPS; cert must contain a PEM certificate block. (not yet implemented; do not select for production)        |
| `PII_KEY_PROVIDER`                                                                              | always in production                                                  | provider selector (`env` or `kms`).                                                                                                            |
| `PII_ACTIVE_KEY_ID`, `PII_KEYRING`                                                              | `PII_KEY_PROVIDER=env`                                                | both required; `PII_KEYRING` must be a JSON object and include `PII_ACTIVE_KEY_ID`.                                                            |
| `PII_KMS_KEYRING` + (`PII_KMS_ACTIVE_KEY_ID` or `PII_ACTIVE_KEY_ID`)                            | `PII_KEY_PROVIDER=kms`                                                | keyring required and must be a JSON object; active key id required.                                                                            |
| `KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, `KLIENT_OPS_TOKEN` | always in production (at least one token required)                    | rotation-safe token set; startup fails if none are set; each provided token must be at least 24 characters.                                    |
| `STORAGE_PROVIDER`                                                                              | always in production                                                  | storage provider selector (`local` or `s3`).                                                                                                   |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`      | `STORAGE_PROVIDER=s3`                                                 | required together when S3 storage is selected.                                                                                                 |

### API rate limiting

The API enforces an in-memory sliding-window rate limit on `/api/*` routes. `/health`, `/ready`, `/api/csrf`, and static assets are exempt. Requests are keyed by a hash of the session cookie when one is present, otherwise by client IP. Limited requests receive `429` with a `Retry-After` header and error code `RATE_LIMITED` in the standard error envelope. Counters are surfaced in `/api/ops/diagnostics` under `data.security.rateLimit`. The limiter is deliberately in-memory (no shared store): the deployment is single-instance. Auth endpoints additionally keep their own durable per-email login lockouts.

| Variable                    | Default                                | Behavior                                                                                       |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`        | `true` (`false` under `NODE_ENV=test`) | Master switch. The test default mirrors `ENABLE_TEST_CSRF_BYPASS` so test suites stay flake-free; disabling it in production emits a startup warning. |
| `RATE_LIMIT_MAX_REQUESTS`   | `600`                                  | Maximum requests per key inside the sliding window.                                            |
| `RATE_LIMIT_WINDOW_SECONDS` | `60`                                   | Sliding-window length in seconds.                                                              |

### Deployment contract consistency

`docker-compose.yml` environment passthrough must be a **superset** of production keys validated by `validateRuntimeConfig()` in `apps/api/src/runtime.mjs`.

### PII KMS key provider configuration

If you set `PII_KEY_PROVIDER=kms`, configure the bootstrap key adapter values as well:

```bash
PII_KEY_PROVIDER=kms
PII_KMS_KEY_ALIAS=pii-master
PII_KMS_ACTIVE_KEY_ID=kms-key-v1
PII_KMS_KEYRING={"kms-key-v1":"plain:base-key-material-v1"}
```

Required behavior and validation:

- `PII_KMS_KEYRING` must be a JSON object keyed by key id.
- `PII_KMS_ACTIVE_KEY_ID` must exist in `PII_KMS_KEYRING` at startup.
- Key material values are decrypted by the KMS adapter before use; unreadable key material fails startup/initialization.
- Rotation requires adding the next key id to `PII_KMS_KEYRING` before switching `PII_KMS_ACTIVE_KEY_ID`.
- Passwords accepted by registration, invite acceptance, and password reset must satisfy the runtime password policy.
- Sessions expire after 8 hours.
- User-session auth is cookie-only. Production/HTTPS emits `__Host-klient-session` and `__Host-klient-csrf`; local HTTP development emits unprefixed `klient-session` and `klient-csrf` so dev browsers persist cookies without weakening production cookie policy.
- Failed login attempts are rate limited per email over a 15-minute window.
- Operational policy for `AUTH_PROVIDER=local` in production: all staff users should enroll TOTP MFA (already built into local auth) as an operational requirement for SEC/SIPC compliance.

## Google sign-in (optional)

Klient supports a real Google (OpenID Connect) interactive sign-in that runs **alongside** the built-in local email+password provider. It is **not** the same as `AUTH_PROVIDER=oidc` (that selector is a reserved, not-yet-implemented federated-provider mode). Google sign-in is an additive login button on the existing local login form; local password login, TOTP MFA, backup codes, and password reset are unchanged.

The implementation is a standards-correct Authorization Code flow with PKCE (S256), `state`, and `nonce` against Google's endpoints, using only `node:crypto` + `fetch` (no new dependencies). The `id_token` is validated locally: RS256 signature via Google's JWKS (with `kid` lookup and key caching), issuer (`https://accounts.google.com`), audience (your client id), `exp`/`iat` (with a small clock-skew allowance), `nonce` match, and `email_verified === true` (hard requirement).

### Configuration (config-gated — off unless set)

Google sign-in is enabled **only** when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. When they are absent:

- `GET /api/auth/google/start` and `GET /api/auth/google/callback` return `404`.
- `GET /api/runtime` reports `googleAuthEnabled: false`, so the login page renders no "Sign in with Google" button.
- There is zero behavior change to local auth.

| Variable              | Required when             | Notes                                                                                                                        |
| --------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`    | to enable Google sign-in  | OAuth 2.0 client id from the Google Cloud console. Enabling requires **both** id and secret.                                |
| `GOOGLE_CLIENT_SECRET`| to enable Google sign-in  | OAuth 2.0 client secret. Never logged; the id_token/access_token are never persisted.                                       |
| `GOOGLE_REDIRECT_URI` | optional                  | Exact callback URL registered in Google. If omitted, derived as `${APP_BASE_URL}/api/auth/google/callback`.                 |
| `APP_BASE_URL`        | optional                  | The app's public origin (e.g. `https://app.example.com`). Used to derive `GOOGLE_REDIRECT_URI` when it is not set explicitly. |

Startup validation (via `validateRuntimeConfig()`): if Google is enabled but no redirect URI can be resolved (`GOOGLE_REDIRECT_URI` unset **and** `APP_BASE_URL` unset), startup fails in production (warning in dev). In production the resolved redirect URI must be `https://`. Setting only one of `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` logs a warning and keeps Google sign-in disabled.

### Google Cloud console steps

1. In the Google Cloud console, create an **OAuth 2.0 Client ID** of type **Web application**.
2. Under **Authorized redirect URIs**, add the exact callback URL: `https://<your-host>/api/auth/google/callback` (must match `GOOGLE_REDIRECT_URI`, or `${APP_BASE_URL}/api/auth/google/callback`).
3. Copy the generated client id and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Configure the OAuth consent screen for your organization (internal is recommended for a single-firm pilot).

### Account handling — no auto-provisioning (invite-only pilot)

A successful Google sign-in matches the **verified** Google email (case-insensitive) to an **existing** user. If no user matches, Klient does **not** create an account — it redirects back to `/login?error=oidc_no_account` with the message "No account exists for this Google email — ask your administrator for an invite." Provision users through the normal invite flow first; Google then federates their sign-in.

### MFA interaction (Google sign-in skips local TOTP)

When a user signs in through Google with a verified Google identity, the session is established directly and the **local TOTP/MFA step is skipped**, even if that user has TOTP enrolled locally. This is standard federated-IdP behavior: Google is the asserting identity provider for that login, so Klient does not re-challenge a local second factor. Enforce your second-factor policy at Google (e.g. require 2-Step Verification on the Google Workspace accounts). Local **password** logins are unaffected and still enforce TOTP MFA. This decision is documented in code at the top of `apps/api/src/auth/google-oidc.mjs`.

### Security notes

- The single-use `state` value is the CSRF/forgery defense for the GET callback (callbacks carry no CSRF token). State rows live in the `oidc_login_states` table (migration 012) with a ~10-minute TTL, are single-use (`used_at`), and are pruned on insert.
- The PKCE `code_verifier` never leaves the server and is never logged.
- No `id_token`/`access_token` is persisted; only the transient verified claims are used to look up the pilot user.
- The session/CSRF cookies issued on Google sign-in use the same secure/SameSite flags as local login.

## Email delivery (optional)

Klient can send plain-text transactional emails for user invites, password resets, and portal links. Like Google sign-in, this is an **optional, additive** capability that is **off by default** (`EMAIL_PROVIDER=disabled`): invites, password resets, and portal links keep returning their tokens in the API response exactly as before. When enabled, delivery is **fire-and-forget** — a send failure is swallowed, logged, and audited, and never changes an API response (the anti-enumeration behavior of password resets is preserved: an unknown email sends nothing and the response is unchanged).

The implementation is a hand-rolled, zero-dependency SMTP client (`apps/api/src/mailer/smtp-client.mjs`) supporting STARTTLS, implicit TLS (port 465), and `AUTH PLAIN`/`AUTH LOGIN`, with RFC 5321 dot-stuffing, CRLF normalization, and a 10s per-command timeout. Plaintext (non-TLS) SMTP is refused in production; it is only tolerated in non-production environments for local catch-all sinks and tests.

### Configuration (config-gated — off unless set)

| Variable         | Required when         | Notes                                                                                                       |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER` | optional              | `disabled` (default) or `smtp`. Any other value fails startup.                                              |
| `SMTP_HOST`      | `EMAIL_PROVIDER=smtp` | SMTP server hostname.                                                                                       |
| `SMTP_PORT`      | optional              | Defaults to `587` (STARTTLS submission). Use `465` with `SMTP_SECURE=true` for implicit TLS.                |
| `SMTP_SECURE`    | optional              | `true` for implicit TLS (port 465); default `false` (plain connection upgraded via STARTTLS).               |
| `SMTP_USERNAME`  | optional              | Enables SMTP AUTH (`PLAIN` preferred, `LOGIN` fallback) when set.                                           |
| `SMTP_PASSWORD`  | optional              | Password for SMTP AUTH. Never logged or audited.                                                            |
| `EMAIL_FROM`     | `EMAIL_PROVIDER=smtp` | Sender address for all transactional email.                                                                 |
| `APP_BASE_URL`   | `EMAIL_PROVIDER=smtp` | Public origin used to build the links in email bodies (shared with Google sign-in redirect derivation).     |

Startup validation (via `validateRuntimeConfig()`): when `EMAIL_PROVIDER=smtp`, missing `SMTP_HOST`, `EMAIL_FROM`, or `APP_BASE_URL` fails startup in production (warning in dev), following the S3-storage validation pattern.

### Audit and privacy

Every attempted delivery records an audit event through the existing audit trail: `email.sent` on success, `email.send_failed` on failure. The audit payload contains only the template name, the provider, and a **masked** recipient (`j***@example.com`) — never the token or the tokenized URL.

## Demo mode vs production

Production deployments should keep `ENABLE_DEMO_MODE=false` (or omit it). Even if set to `true`, runtime forces demo mode off in production (`NODE_ENV=production`).

For local demonstrations only:

- set `ENABLE_DEMO_MODE=true`
- start with a clean `data/app.db` if you want a fresh seeded demo account (`admin@demo.test`)

## Primary release operator workflow (required)

Run the operator command (fails fast, exact documented order):

```bash
export RELEASE_ID=<release-id>
export KLIENT_BASE_URL=https://<env-host>
export KLIENT_OPS_TOKEN_ACTIVE=<ops-token-active>
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```

This command writes all artifacts under `artifacts/release-evidence/<release-id>` and executes:

1. Flow A preflight: backup metadata -> merge/main parity -> `validate:master`
2. Post-deploy validation: `/health` -> `/ready` -> `/api/ops/exports/queue` -> `/api/ops/diagnostics`

Required environment variables:

- `RELEASE_ID` (or pass `--release-id`) to scope evidence output.
- `KLIENT_BASE_URL` for post-deploy `/health` and `/ready`.
- One of `KLIENT_OPS_TOKEN_ACTIVE` / `KLIENT_OPS_TOKEN_PREVIOUS` / `KLIENT_OPS_TOKENS` / `KLIENT_OPS_TOKEN` for authenticated post-deploy diagnostics.
- `RESTORE_BACKUP_PATH` only when running `--phase restore` or `--phase restore-drill`.

Hard gate only (non-approval diagnostic/manual mode):

```bash
npm run validate:master
```

Release approval hard-gate command (single strict path; CI-compatible):

```bash
RELEASE_APPROVAL_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master
```

In release approval mode, fallback is prohibited and any fallback evidence is non-approving.

Evidence artifacts (machine-readable, emitted automatically):

```text
artifacts/release-evidence/<release-id>/validate-master-summary.json
artifacts/release-evidence/<release-id>/api-contract-summary.json
artifacts/release-evidence/<release-id>/integration-summary.json
artifacts/release-evidence/<release-id>/migration-summary.json
artifacts/release-evidence/<release-id>/smoke-summary.json
artifacts/release-evidence/<release-id>/security-summary.json
```

Optional explicit destination controls for manual hard-gate use:

```bash
RELEASE_EVIDENCE_DIR=artifacts/release-evidence/<release-id> npm run validate:master
# or
RELEASE_EVIDENCE_FILE=artifacts/release-evidence/<release-id>/validate-master-summary.json npm run validate:master
```

The gate is objective and fails if any required suite fails:

1. React frontend build (`npm run web:build`)
2. API contract tests (`npm run test:contract`)
3. Integration suites (`npm run test:integration`)
4. Migration order checks (`npm run check:migrations`)
5. Smoke test (`npm run test:smoke`, including PDF template ingestion, linked generated form submission, PDF/XLSX export processing, and artifact download)
6. Security checks (`npm run test:security`)

Before approving GO/NO-GO, complete and archive the standardized handoff package in
`docs/release-handoff-template.md`.
When completing Section 2 of that package, explicitly record:

- selected `AUTH_PROVIDER` path (`local` is the supported production mode; `oidc`/`saml` are not yet implemented) and companion key presence checks,
- selected `PII_KEY_PROVIDER` path (`env` or `kms`) and companion key presence checks,
- selected ops token path (`KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, or legacy `KLIENT_OPS_TOKEN`) and rotation/remove timing,
- and immutable release identity values (release ID, commit/tag, image digest, environment).

Quick operator reference (exact phase commands, env vars, artifacts, failure signatures):
`docs/deployment-quick-reference.md`.

## Deterministic test environment behavior

- Use isolated test state by default (ephemeral test directories).
- Deterministic port assignment is based on `TEST_SEED` and suite name.
- Optional tuning knobs:
  - `TEST_RESET_BEHAVIOR=isolated|shared` (default `isolated`)
  - `TEST_SEED=<string>` (default `klient-seed`)
  - `TEST_PORT_BASE=<number>` (default `3300`)
  - `TEST_PORT_RANGE=<number>` (default `300`)

If you need to reset local runtime state explicitly:

```bash
npm run reset:test-data
```

## Local Docker run

```bash
docker compose --env-file .env up --build -d
```

The Dockerfile builds the React app during image creation and copies the generated `apps/web/dist` assets into the runtime image, so deployments do not rely on checked-in build output. The app will be available at `http://localhost:3000`.

`docker-compose.yml` also starts `kinetic-klient-export-worker`, a companion process that runs `node scripts/export-worker.mjs` against the same storage/database volume. Production deployments must run this worker (or an equivalent scheduler using the same command) alongside the API; the API only enqueues export jobs.

### Container filesystem policy

- The runtime container is designed to run with a **read-only root filesystem**.
- Required writable paths are:
  - `/app/data` for SQLite runtime state (`data/app.db`)
  - `/tmp` for temporary files
  - `/app/tmp` for app-scoped temporary files
- `docker-compose.yml` enables this policy via `read_only: true`, two `tmpfs` mounts (`/tmp`, `/app/tmp`), and a bind/volume mount for `/app/data`.

## Optional TLS via Caddy

The compose file ships an optional `caddy` reverse-proxy service behind the `tls` compose profile. Without the profile, nothing changes: the app serves plain HTTP on port 3000 exactly as before. With the profile, Caddy terminates HTTPS on ports 443 (and redirects HTTP on 80) and proxies to the app service:

```bash
docker compose --env-file .env --profile tls up --build -d
```

The proxy configuration lives in `deploy/Caddyfile` and is mounted read-only into the container; certificate material persists in the `caddy_data`/`caddy_config` named volumes across restarts.

### LAN / local pilot (no public domain): Caddy internal CA

The default `deploy/Caddyfile` uses the `tls internal` directive, so Caddy issues certificates from its own local certificate authority — no internet access or public DNS required. Clients on the LAN must trust that local root CA once:

1. Export the root certificate from the running container:
   ```bash
   docker compose --profile tls cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
   ```
2. Install `caddy-local-root.crt` on each client machine: Windows — `certmgr.msc`, import into "Trusted Root Certification Authorities"; macOS — Keychain Access, System keychain, set to "Always Trust"; Firefox manages its own store — import under Settings → Privacy & Security → Certificates.
3. Point the hostname used in the Caddyfile (default `klient.local`) at the Docker host via internal DNS or each client's hosts file.

### Future: public domain (automatic Let's Encrypt)

When the deployment gets a public DNS name and ports 80/443 are reachable from the internet, switch `deploy/Caddyfile` to the commented public-domain variant (a site block for the real domain, without `tls internal`). Caddy then obtains and renews publicly trusted certificates from Let's Encrypt automatically, and clients need no manual CA trust step.

## Health and readiness

Use:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl -I http://localhost:3000/health
```

`/ready` verifies SQLite connectivity and returns:

- table query counts
- storage diagnostics (file path, size, quick check, latency)
- export worker queue status
- audit event totals/latest record
- runtime config validation (issues/warnings)

For deeper runtime diagnostics per tenant, call:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/ops/diagnostics
```

This includes startup metadata (`bootedAt`, PID, uptime), config validation details, storage health, export status distribution, and firm audit summaries.

## Persistent data

The app stores runtime data in `data/app.db`.
Mount `./data` into the container to persist changes across restarts.

## Backup and restore

Create a backup:

```bash
node scripts/backup-db.mjs | tee artifacts/release-evidence/<release-id>/backup.json
```

Restore from a backup file (live rollback execution):

```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db | tee artifacts/release-evidence/<release-id>/restore.json
```

Run a verify-only restore drill (uses a temporary path and removes it after integrity checks):

```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db --verify-only | tee artifacts/release-evidence/<release-id>/restore-drill.json
```

Both scripts emit structured JSON metadata for release evidence automation:

- backup: `operation`, `status`, `artifact.path`, `artifact.sizeBytes`, `artifact.sha256`, `artifact.sqliteQuickCheck`, `startedAt`, `finishedAt`
- restore/verify: `operation`, `status`, `executionMode` (`live-restore` or `verify-only-drill`), `evidenceLabel`, `source.*`, `restoreTarget.*`, `restoreTarget.kind`, `checks.sizeMatch`, `checks.sha256Match`, `checks.sourceQuickCheckOk`, `checks.targetQuickCheckOk`, timestamps

> The `scripts/backup-db.mjs` / `scripts/restore-db.mjs` pair above produces
> **unencrypted** `.db` snapshots and is retained for the release-evidence
> rollback flow. For at-rest protection of SSNs and other PII, operate the
> **encrypted** pipeline below (`npm run backup` / `npm run restore`) as the
> default day-to-day and scheduled backup mechanism.

## Backups & restore (encrypted)

Because the database stores field-level-encrypted SSNs, scheduled backups are
themselves **encrypted at rest** so a stolen backup file leaks nothing.

### How it works

1. `npm run backup` (→ `scripts/backup.mjs`) runs `VACUUM INTO` a temp file — a
   WAL-safe, consistent, checkpointed snapshot taken through SQLite itself, not
   a copy of a live file mid-write.
2. It runs `PRAGMA quick_check` on the snapshot.
3. It encrypts the snapshot with **AES-256-GCM** and writes a single
   self-contained artifact: 4-byte magic `KLBK`, a 4-byte header length, a JSON
   header (version, algorithm, `createdAt`, key metadata, `iv`, `authTag`,
   `plaintextSha256`), then the ciphertext. The IV is a random 96-bit nonce and
   the 128-bit GCM auth tag detects any tampering.
4. Artifacts land in `BACKUP_DIR` (default `data/backups`) named
   `backup-<timestamp>.klbackup`.
5. **Retention:** the newest `BACKUP_RETENTION` (default 7) artifacts are kept;
   older ones are deleted.

### Encryption key

- **`BACKUP_ENCRYPTION_KEY` (recommended):** a dedicated key. Provide either a
  64-character hex string (used directly as a 32-byte key) or any passphrase
  (stretched with `scrypt` and a random per-artifact salt stored in the header).
  Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- **Fallback:** if `BACKUP_ENCRYPTION_KEY` is unset, the key is derived from
  `APP_SECRET` via `scrypt`, and the backup **warns loudly**. A dedicated key is
  strongly recommended so backup and app secrets rotate independently.

Restore must run with the **same** environment variable that produced the
artifact (the header records `keySource`, so it reads `BACKUP_ENCRYPTION_KEY` or
`APP_SECRET` accordingly).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_ENCRYPTION_KEY` | (unset → APP_SECRET fallback) | Dedicated backup key: 64-hex raw key, or a passphrase (scrypt-stretched). |
| `BACKUP_DIR` | `data/backups` | Where artifacts are written. |
| `BACKUP_RETENTION` | `7` | Number of newest artifacts to keep. |
| `BACKUP_INTERVAL_SECONDS` | `86400` | Interval for the compose backup service. |

### Run a manual backup

```bash
BACKUP_ENCRYPTION_KEY=<64-hex> npm run backup
```

### Restore + verify

Verify-only drill (decrypts to a temp path, runs `quick_check` +
`integrity_check`, then removes it — never touches the live DB):

```bash
BACKUP_ENCRYPTION_KEY=<64-hex> npm run restore -- data/backups/backup-<timestamp>.klbackup --verify-only
```

Live restore (refuses to overwrite `data/app.db` without `--force`; stop the API
first):

```bash
BACKUP_ENCRYPTION_KEY=<64-hex> npm run restore -- data/backups/backup-<timestamp>.klbackup --out data/app.db --force
```

A tampered artifact or a wrong key **fails auth-tag verification** and the
restore aborts before writing anything usable.

### Restore drill (automated)

`npm run backup:verify` runs `apps/api/src/test/backup-restore-drill.test.mjs`,
which seeds known rows across relational tables (firms, profiles, notes,
audit_events, sessions), takes an encrypted backup, restores it to a temp path,
and asserts: (a) `quick_check` ok, (b) per-table row counts match the source,
(c) a flipped ciphertext byte makes restore fail, and (d) a wrong key fails to
decrypt. It also runs as part of the default `node --test` suite.

### Scheduling

**Docker Compose (behind the `backup` profile):**

```bash
docker compose --profile backup up --build -d
```

The `kinetic-klient-backup` service loops `scripts/backup.mjs` every
`BACKUP_INTERVAL_SECONDS` (default 24h), mounting the shared `./data` volume.
It does not affect the default services or the `tls` profile.

**Host `cron` (Linux/macOS)** — daily at 02:30, keeping the newest 14:

```cron
30 2 * * * cd /srv/kinetic-klient && BACKUP_ENCRYPTION_KEY=<64-hex> BACKUP_RETENTION=14 /usr/bin/node scripts/backup.mjs >> /var/log/klient-backup.log 2>&1
```

**Windows Task Scheduler** — daily trigger running:

```powershell
node C:\srv\kinetic-klient\scripts\backup.mjs
```

with `BACKUP_ENCRYPTION_KEY`, `BACKUP_DIR`, and `BACKUP_RETENTION` set as
environment variables for the task's user (or the machine).

### WAL caveat

The snapshot uses `VACUUM INTO`, which produces a single self-contained database
file with **no `-wal` sidecar**, so restores never miss committed data still
living in the WAL. (Older copy-`data/app.db`-only scripts could — see "Rolling
back across a WAL/schema upgrade" below.)

## Deterministic operations flows

### Flow A — deterministic preflight (single command)

Run exactly one command before deployment:

```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight
```

PASS criteria (all required):

- command exits `0`
- backup evidence JSON reports `ok=true`, `status=succeeded`, positive `artifact.sizeBytes`, `artifact.sqliteQuickCheck=ok`
- branch parity command exits `0`
- hard gate command exits `0` with `validate-master-summary.json` status `passed`

### Flow B — deterministic restore-validation (single command)

Run this command only for a real rollback restore (writes to the live DB path):

```bash
RESTORE_BACKUP_PATH=data/backup-<timestamp>.db \
  npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"
```

### Flow B.1 — verify-only restore drill (single command)

Run this command for drill evidence without touching the live DB path:

```bash
RESTORE_BACKUP_PATH=data/backup-<timestamp>.db \
  npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"
```

### Restore evidence decision rules

- Live rollback evidence: `restore.json` and `executionMode=live-restore`.
- Drill evidence only: `restore-drill.json` and `executionMode=verify-only-drill`.
- Never mark a live rollback as complete based on `restore-drill.json`.

## Deployment playbook

1. **Pre-flight**
   - Execute `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` exactly once.
2. **Deploy**
   - Build and launch (`docker compose --env-file .env up --build -d`); the image build runs `npm --prefix apps/web run build`.
3. **Deterministic post-deploy validation** (run in exact order)
   - Execute `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy`.
   - Machine-verifiable readiness keys: `status`, `checks.databaseReady`, `checks.storageReady`, `checks.exportQueueReachable`, `checks.startupConfigValid`.
   - Optional: run smoke against deployed environment and archive output (`npm run test:smoke | tee artifacts/release-evidence/<release-id>/post-deploy-smoke.txt`).

## Rollback playbook

Rollback is mandatory if health checks degrade, smoke fails, or security regressions are observed.

### Rollback compatibility

The database now runs in WAL journal mode with a versioned schema (`PRAGMA user_version` 4+). Rolling back to a pre-WAL release is **not supported** without restoring from a backup taken by that older release: old backup scripts copy `data/app.db` alone, without the `-wal` file, and can silently miss committed data that still lives in the WAL.

Safe rollback procedure across the WAL boundary:

1. Stop the app (API and export worker).
2. Take a backup with the **current** release's backup script (`node scripts/backup-db.mjs`) — it uses `VACUUM INTO`, which produces a single self-contained database file with no WAL sidecar.
3. Restore that backup with the **old** release's restore script, then start the old release.

### Explicit rollback SLO/SLA triggers

- `/health` or `/ready` non-200 for more than **5 minutes** after deploy.
- Critical smoke journey failure persisting more than **10 minutes** after one remediation attempt.
- Contract incompatibility affecting any production consumer (SLA breach).
- Security regression (auth bypass, PII exposure risk, or crypto integrity failure).
- Observability SLO breach: sustained high error rate / latency / queue saturation for **10+ minutes** with active alerts.

1. Stop unhealthy revision and redeploy the previous known-good image/tag.
2. Restore database only when data integrity is compromised:
   ```bash
   RESTORE_BACKUP_PATH=data/backup-<timestamp>.db \
     npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"
   ```
3. Re-run **Flow B — deterministic restore-validation** and then readiness/smoke checks.
4. Record rollback timestamp, trigger reason, and backup artifact in release notes.

## Background export processing

Queued exports are processed by the companion worker:

```bash
npm run exports:worker
```

The worker fills source-backed AcroForm PDFs from persisted uploaded template artifacts, writes structured XLSX workbooks for advisor operations, stores completed bytes in the configured object storage provider, and leaves renderer/fallback diagnostics on the export job. Download endpoints serve the persisted artifact for completed jobs; compatibility re-rendering is retained only for older completed jobs that predate persisted object metadata.

`POST /api/exports/process` is deprecated for normal operation. It remains available as an authenticated admin recovery tick when the companion worker is unavailable or during a controlled diagnostic, and the UI labels it as a recovery action rather than the primary export lifecycle.

## Logs and shutdown

The API emits structured JSON logs to stdout/stderr.
Use your container/runtime log collector to ship them to your observability stack.
The server also handles `SIGTERM`/`SIGINT` for graceful shutdown.

On startup, the app emits a `server.started` log event with an embedded diagnostics snapshot. If configuration warnings exist, a `runtime.config.warnings` event is emitted. In production, configuration errors block startup before bind/listen and emit `server.startup.blocked` with `startupDiagnostics.issues`; in non-production, the server still starts and logs `runtime.config.invalid`.

### Operational acceptance criteria (release validation)

Release validation is incomplete unless all three telemetry domains pass:

- **Logs**: deployment-window logs present, structured, and searchable with startup + error events.
- **Metrics**: error rate, latency, and saturation remain within SLO thresholds across validation window.
- **Alerts**: no unresolved critical/high alerts for the new revision; warning alerts have owner and ETA.

## Build context hygiene

A `.dockerignore` file excludes git metadata, local SQLite data, logs, root/web `node_modules`, and stale `apps/web/dist` output from image builds so Docker packages only assets generated inside the image build.
