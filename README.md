# Kinetic Klient Rebuild

This repository now contains a **single-command runnable advisory onboarding prototype** that is ready for end-to-end local testing without external package installation.

## What is included
- admin firm bootstrap and sign-in
- persistent SQLite-backed local data storage in `data/app.db`
- dashboard with stats and recent activity
- prospects and clients management
- persisted prospect pipeline board
- households and member linking
- dynamic form template and submission foundation
- document template and mapping foundation
- export job foundation
- audit trail view
- analytics endpoint and internal analytics view
- invite flow, password reset endpoints, and client portal link generation
- internal web UI served by the backend

## Run locally
```bash
node apps/api/src/server.mjs
```

Then open:
- `http://localhost:3000`

## Demo credentials
- `admin@demo.test`
- `ChangeMe123!`

## Smoke test
```bash
node scripts/smoke-test.mjs
```

## Data location
All persisted demo data is stored in:
- `data/app.db`

Delete that file to reseed the app.

## Docker deployment
```bash
docker compose up --build
```

See `DEPLOYMENT.md` for deployment details and the `/health` endpoint.


## Portal view
Open `http://localhost:3000/portal?token=...` with a generated portal token to view shared client data.


## Backup
```bash
node scripts/backup-db.mjs
```

This writes a timestamped SQLite backup into `data/`.

## CI
A GitHub Actions smoke workflow is included at `.github/workflows/smoke.yml`.


## Export worker
```bash
node scripts/export-worker.mjs
```

This processes queued export jobs in the SQLite-backed runtime.
