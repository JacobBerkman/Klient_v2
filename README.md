# Kinetic Klient Rebuild

This repository contains a **single-command runnable advisory onboarding app** with persistent SQLite storage, structured API logging, Docker packaging, health/readiness probes, backup/restore scripts, and layered test coverage (fast smoke + focused integration suites) for the main user flows.

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
- audit trail and analytics views
- invite flow and password reset endpoints
- internal web UI served by the backend
- Docker + compose deployment artifacts
- backup, restore, and export worker scripts

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
Run the fast smoke path:

```bash
npm run test:smoke
```

Run all focused integration suites:

```bash
npm run test:integration
```

Run the full local validation bundle:

```bash
npm run test:all
```

Available integration suites:
- `npm run test:integration:tenancy`
- `npm run test:integration:rbac`
- `npm run test:integration:exports`
- `npm run test:integration:templates`
- `npm run test:integration:portal-lifecycle`
- `npm run test:integration:analytics`

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
GitHub Actions keeps quick feedback via the smoke job, then fans out domain integration suites (`tenancy`, `rbac`, `exports`, `templates`, `portal lifecycle`, `analytics`) in parallel using `.github/workflows/smoke.yml`.
