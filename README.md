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
- audit trail and analytics views
- invite flow and password reset endpoints
- session lifecycle controls with per-user and admin revocation
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
Run the smoke test:

```bash
node scripts/smoke-test.mjs
```

Run auth/session lifecycle coverage (invite expiry, reset expiry, session revocation, and auth audit events):

```bash
node scripts/auth-lifecycle-test.mjs
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

## Auth/session lifecycle behavior
- `POST /api/logout` revokes only the current bearer token session and records an `auth.session.revoked` audit event.
- `POST /api/logout-all` revokes all sessions for the current user and records an `auth.session.revoked` audit event.
- `POST /api/users/:userId/sessions/revoke` allows admin users to revoke all sessions for a same-firm user and records an `auth.session.revoked` audit event.
- Session tokens expire after 8 hours.
- Invite tokens (`POST /api/invites`) expire after 7 days and expired invites cannot be accepted.
- Password reset tokens (`POST /api/password-resets`) expire after 1 hour and expired resets cannot be completed.
- Audit events are recorded for `auth.login.succeeded`, `auth.login.failed` (known user email), `auth.password_reset.completed`, `invite.accepted`, and `auth.session.revoked`.

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
