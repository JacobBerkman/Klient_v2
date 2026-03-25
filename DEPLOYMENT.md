# Deployment

## Canonical runtime
Deploy the application by running the single Node server at `apps/api/src/server.mjs`.

Node runtime policy: production containers track the active Node.js **LTS major** (currently 22) and pin an immutable base-image digest for reproducible builds.
That process serves:
- the JSON API,
- the advisor SPA from `apps/web/public`,
- and the portal UI from `/portal`.

## Environment contract
Copy `.env.example` to `.env` and set at least:

```bash
APP_SECRET=replace-with-a-long-random-secret
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
```

### Production requirements
- `APP_SECRET` must be set to a long random value.
- Passwords accepted by registration, invite acceptance, and password reset must satisfy the runtime password policy.
- Sessions expire after 8 hours.
- Failed login attempts are rate limited per email over a 15-minute window.

## Hard release gate (required before every deploy)
Run this command and require a **zero-exit** outcome:

```bash
npm run validate:master
```

The gate is objective and fails if any required suite fails:
1. API contract tests (`npm run test:contract`)
2. Integration suites (`npm run test:integration`)
3. Migration order checks (`npm run check:migrations`)
4. Smoke test (`npm run test:smoke`)
5. Security checks (`npm run test:security`)

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

The app will be available at `http://localhost:3000`.

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
node scripts/backup-db.mjs
```

Restore from a backup file:

```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

## Deployment playbook
1. **Pre-flight**
   - Ensure backup created (`npm run backup`).
   - Confirm branch parity (`npm run check:merge-main`).
   - Run full release gate (`npm run validate:master`).
2. **Deploy**
   - Build and launch (`docker compose --env-file .env up --build -d`).
   - Confirm `/health` and `/ready` are green.
   - Login and verify key advisor flow in UI.
3. **Post-deploy validation**
   - Execute smoke test against deployed environment (or equivalent canary route checks).
   - Validate export queue processing and analytics endpoints.

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
   npm run restore -- data/backup-<timestamp>.db
   ```
3. Re-run readiness and smoke checks.
4. Record rollback timestamp, trigger reason, and backup artifact in release notes.

## Background export processing
Queued exports can be processed out of band with:

```bash
node scripts/export-worker.mjs
```

## Logs and shutdown
The API emits structured JSON logs to stdout/stderr.
Use your container/runtime log collector to ship them to your observability stack.
The server also handles `SIGTERM`/`SIGINT` for graceful shutdown.

On startup, the app emits a `server.started` log event with an embedded diagnostics snapshot. If configuration warnings exist, a `runtime.config.warnings` event is emitted; configuration errors produce `runtime.config.invalid`.

### Operational acceptance criteria (release validation)
Release validation is incomplete unless all three telemetry domains pass:
- **Logs**: deployment-window logs present, structured, and searchable with startup + error events.
- **Metrics**: error rate, latency, and saturation remain within SLO thresholds across validation window.
- **Alerts**: no unresolved critical/high alerts for the new revision; warning alerts have owner and ETA.

## Build context hygiene
A `.dockerignore` file excludes git metadata, local SQLite data, logs, and `node_modules` from image builds so Docker packages only the shipped runtime assets.
