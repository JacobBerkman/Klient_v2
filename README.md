# Kinetic Klient Rebuild

This repository contains a **single-command runnable advisory onboarding app** using the shipped Node runtime at `apps/api/src/server.mjs`.

## Current implemented scope
The following flows are implemented in this codebase today:
- firm admin bootstrap and sign-in
- persistent SQLite runtime storage in `data/app.db`
- dashboard with basic stats and recent activity
- prospects and clients management
- persisted prospect pipeline board with stage updates
- households and member linking
- form templates plus draft/submitted onboarding responses
- token-based client portal for draft and submitted responses
- document template records and export job processing
- audit trail list and analytics summary view
- invite creation and password reset endpoints
- internal web UI served by the backend
- Docker + compose deployment artifacts
- backup, restore, and export worker scripts

## Roadmap (not fully implemented yet)
These are planned platform improvements and should not be treated as complete production capabilities yet:
- advanced RBAC and policy enforcement across every endpoint
- hardened portal security controls beyond token access (for example, expiry/rotation workflows)
- full asynchronous queue infrastructure for exports (current worker is SQLite state based)
- richer analytics/reporting and compliance-specific dashboards
- deeper template/version governance workflows

## Environment
Copy `.env.example` to `.env` for deployment-oriented runs.
In production, `APP_SECRET` must be set to a long random value.

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

This processes queued export jobs in the SQLite-backed runtime.

## CI
A GitHub Actions smoke workflow is included at `.github/workflows/smoke.yml`.
