# Kinetic Klient Rebuild

This repository contains a **single-command runnable advisory onboarding app** with persistent SQLite storage, structured API logging, Docker packaging, health/readiness probes, backup/restore scripts, and smoke-test coverage for the main user flows.

## What is included
- admin firm bootstrap and sign-in
- persistent SQLite-backed local data storage in `data/app.db`
- dashboard with stats and recent activity
- prospects and clients management
- persisted prospect pipeline board
- households and member linking
- dynamic form template and submission flows
- guided client portal for draft and submitted onboarding responses
- document template and export job foundations
- unified object storage abstraction for uploaded templates, client-uploaded documents, and generated exports
- audit trail and analytics views
- invite flow and password reset endpoints
- internal web UI served by the backend
- Docker + compose deployment artifacts
- backup, restore, and export worker scripts

## Environment
Copy `.env.example` to `.env` for deployment-oriented runs.
In production, `APP_SECRET` must be set to a long random value.
Object storage defaults to local filesystem in development and should be configured to S3/MinIO-compatible storage in production.

## Run locally
```bash
node apps/api/src/server.mjs
```

Then open:
- `http://localhost:3000`

## Demo credentials
- `admin@demo.test`
- `ChangeMe123!`

## Testing
Run the smoke test:

```bash
node scripts/smoke-test.mjs
```

Run the broader local validation bundle:

```bash
npm run test:all
```

## Data location
All persisted demo/runtime data is stored in:
- `data/app.db`
- `data/storage` (when using local object storage backend)

Delete that file to reseed the app.

## Docker deployment
```bash
docker compose --env-file .env up --build -d
```

See `DEPLOYMENT.md` for deployment details, environment variables, health checks, and restore procedures.

## Health endpoints
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## Portal view
Open `http://localhost:3000/portal?token=...` with a generated portal token to review shared client data, save drafts, and submit onboarding form responses.

## Backup
```bash
node scripts/backup-db.mjs
```

This writes a timestamped SQLite backup into `data/`.

## Restore
```bash
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

## Export worker
```bash
node scripts/export-worker.mjs
```

This processes queued export jobs and writes generated files via the configured object storage backend.

## Object storage configuration
Use these variables:

- `OBJECT_STORAGE_BACKEND=local|s3`
- `OBJECT_STORAGE_LOCAL_PATH` (local backend path, default `data/storage`)
- `OBJECT_STORAGE_BUCKET` (required for `s3`)
- `OBJECT_STORAGE_REGION` (default `us-east-1`)
- `OBJECT_STORAGE_ENDPOINT` (optional, use for MinIO/self-hosted S3)
- `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` (required for `s3`)
- `OBJECT_STORAGE_FORCE_PATH_STYLE=true|false` (set `true` for most MinIO setups)

### Migration expectation
Existing rows in SQLite continue to work without backfilling object files. Newly uploaded templates, client documents, and generated exports include object references and use the configured backend. If moving from local to S3/MinIO, migrate existing files out-of-band and update object references only if you need historical file downloads.

## CI
A GitHub Actions smoke workflow is included at `.github/workflows/smoke.yml`.
