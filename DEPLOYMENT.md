# Deployment

## Canonical runtime

Deploy the application by running the single Node server at `apps/api/src/server.mjs`.

Node runtime policy: production containers track the active Node.js **LTS major** (currently 22) and pin an immutable base-image digest for reproducible builds.
This deployment remains a single-process **Node + SQLite + static web** architecture:

- the Node process serves the JSON API,
- SQLite persists runtime data in `data/app.db`,
- canonical React/Vite assets are built from `apps/web/src` into `apps/web/dist` during CI/Docker image creation,
- the backend serves `apps/web/dist` first for product routes including `/portal`,
- and `apps/web/public` is legacy-only, retained explicitly at `/legacy` and `/legacy/portal` until retirement.

## Environment contract

Copy `.env.example` to `.env` and set the runtime-required production variables.

```bash
NODE_ENV=production
APP_SECRET=replace-with-a-long-random-secret
AUTH_PROVIDER=oidc
KLIENT_OPS_TOKEN_ACTIVE=replace-with-24-plus-char-ops-token-active
PII_KEY_PROVIDER=env
PII_ACTIVE_KEY_ID=app-key-v1
PII_KEYRING={"app-key-v1":"plain:replace-with-32-byte-base64-or-hex-key"}
```

### Production runtime-required variables (exactly enforced)

| Variable                                                                                        | Required when                                                         | Runtime enforcement                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                                                                    | always in production                                                  | must be explicitly set and meet minimum strength requirements.                                                                                 |
| `AUTH_PROVIDER`                                                                                 | always in production                                                  | must be explicitly set; `local` requires `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true`, otherwise startup is blocked.                          |
| `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS`                                                        | only for approved incidents where `AUTH_PROVIDER=local` in production | break-glass override to temporarily permit local auth in production; emits runtime warning and should be removed immediately after mitigation. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`                  | `AUTH_PROVIDER=oidc`                                                  | all required; issuer + redirect must be HTTPS; client secret must be >= 16 chars.                                                              |
| `SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_CERT`                                                  | `AUTH_PROVIDER=saml`                                                  | all required; entry point must be HTTPS; cert must contain a PEM certificate block.                                                            |
| `PII_KEY_PROVIDER`                                                                              | always in production                                                  | provider selector (`env` or `kms`).                                                                                                            |
| `PII_ACTIVE_KEY_ID`, `PII_KEYRING`                                                              | `PII_KEY_PROVIDER=env`                                                | both required; `PII_KEYRING` must be a JSON object and include `PII_ACTIVE_KEY_ID`.                                                            |
| `PII_KMS_KEYRING` + (`PII_KMS_ACTIVE_KEY_ID` or `PII_ACTIVE_KEY_ID`)                            | `PII_KEY_PROVIDER=kms`                                                | keyring required and must be a JSON object; active key id required.                                                                            |
| `KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, `KLIENT_OPS_TOKEN` | always in production (at least one token required)                    | rotation-safe token set; startup fails if none are set; each provided token must be at least 24 characters.                                    |
| `STORAGE_PROVIDER`                                                                              | always in production                                                  | storage provider selector (`local` or `s3`).                                                                                                   |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`      | `STORAGE_PROVIDER=s3`                                                 | required together when S3 storage is selected.                                                                                                 |

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

- selected `AUTH_PROVIDER` path (`oidc`/`saml` required for normal production GO, `local` only with recorded break-glass approval) and companion key presence checks,
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

The Dockerfile builds the React app during image creation and copies the generated `apps/web/dist` assets into the runtime image, so deployments do not rely on checked-in build output. The app will be available at `http://localhost:3000`; legacy fallback remains explicit at `/legacy` and `/legacy/portal`.

`docker-compose.yml` also starts `kinetic-klient-export-worker`, a companion process that runs `node scripts/export-worker.mjs` against the same storage/database volume. Production deployments must run this worker (or an equivalent scheduler using the same command) alongside the API; the API only enqueues export jobs.

### Container filesystem policy

- The runtime container is designed to run with a **read-only root filesystem**.
- Required writable paths are:
  - `/app/data` for SQLite runtime state (`data/app.db`)
  - `/tmp` for temporary files
  - `/app/tmp` for app-scoped temporary files
- `docker-compose.yml` enables this policy via `read_only: true`, two `tmpfs` mounts (`/tmp`, `/app/tmp`), and a bind/volume mount for `/app/data`.

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
