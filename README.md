# Kinetic Klient Rebuild

This repository contains a **single-command runnable advisory onboarding app** with a plain Node.js HTTP server as the production backend, persistent SQLite storage, structured API logging, Docker packaging, health/readiness probes, backup/restore scripts, and end-to-end contract coverage for the main user flows.

## User-facing claim status (audited)

| Claim | Status | Notes |
|---|---|---|
| Advisory onboarding dashboard + prospects/clients/households/forms | `implemented` | Fully available in current runtime. |
| Advisor analytics panels (funnel, stage aging, completion, productivity) | `implemented` | Available in advisor UI and analytics endpoints. |
<<<<<<< codex/implement-conflict-handling-in-forms-module
| Collaborative draft editing safeguards | `implemented` | Conflict guard + lease recovery are now enforced across API + UI draft flows with integration coverage. See [Milestone M2](docs/milestones/claims-roadmap.md#milestone-m2-draft-collaboration-hardening). |
| Queue-backed export/document automation | `roadmap` | Foundation exists, end-to-end orchestration is planned behind `FF_EXPORT_AUTOMATION`. See [Milestone M3](docs/milestones/claims-roadmap.md#milestone-m3-export-automation). |
=======
| Collaborative draft editing safeguards | `partial` | Core flows exist; conflict hardening remains gated behind `FF_DRAFT_CONFLICT_GUARD`. See [Milestone M2](docs/milestones/claims-roadmap.md#milestone-m2-draft-collaboration-hardening). |
| Queue-backed export/document automation | `implemented` | Queue orchestration now includes retry-safe processing, dead-letter handling, machine-usable queue diagnostics, and verified artifact readiness/download flows. |
>>>>>>> main

## What is included
- admin firm bootstrap and sign-in
- persistent SQLite-backed local data storage in `data/app.db`
- dashboard with stats and recent activity
- prospects and clients management
- persisted prospect pipeline board
- households and member linking
- dynamic form template and submission flows
- collaborative draft editing with revision IDs, lock leases, and conflict prompts
- guided client portal for draft and submitted onboarding responses
- document templates and queue-backed export job automation with retry/dead-letter orchestration
- audit trail plus advisor-facing analytics panels (funnel conversion, stage aging, form completion, productivity)
- invite flow and password reset endpoints
- internal web UI served by the backend
- operational diagnostics for runtime config, storage health, export worker queue, and audit counts
- Docker + compose deployment artifacts
- backup, restore, and export worker scripts

## Environment
Copy `.env.example` to `.env` for deployment-oriented runs.
In production, `APP_SECRET` must be set to a long random value.

## Run locally
Kinetic Klient is now consolidated onto **one real runtime architecture**:

- a single Node.js HTTP server at `apps/api/src/server.mjs`
- SQLite-backed persistence in `data/app.db`
- the advisor web UI served directly from `apps/web/public`
- the client portal served from `/portal`

The older duplicate Fastify/TypeScript backend path and related workspace scaffolding have been removed so the repository now has one real startup path.

## Product capabilities
- firm admin registration and sign-in
- persistent session-backed advisory workspace
- dashboard with recent activity and operating stats
- prospect/client creation, search, detail, notes, and stage management
- household creation, member management, and spouse linking/creation
- masked sensitive data handling for SSNs and tax IDs
- form template creation plus advisor and portal submission flows
- document templates, auto-build mappings, export jobs, and worker processing
- production-grade template mapper/editor UX with mapping inspector, autosave state, AcroForm field status, and mapping preview checks
- upgraded export rendering (PDF layout + formatted XLSX worksheet metadata) while preserving queue/object metadata behavior
- invite and password reset flows
- readiness/health probes, backup/restore scripts, Docker packaging, and smoke coverage

## Runtime architecture kept
The repo now treats the plain Node runtime as canonical because it is the path that already:
- serves the API and static UI together,
- persists real state to SQLite,
- powers the smoke test and Docker startup path,
- and can be verified end-to-end without a second backend stack.

That eliminates the split-brain between competing backend implementations and keeps local, Docker, CI, and smoke verification on the same runtime.

## Local development
```bash
node apps/api/src/server.mjs
```

Open:
- `http://localhost:3000`
- `http://localhost:3000/portal?token=<token>`

## Demo mode (optional, non-production only)
Set `ENABLE_DEMO_MODE=true` when running locally if you want seeded demo data and UI shortcuts.

Demo credentials (only when demo mode is enabled):
- Email: `admin@demo.test`
- Password: `ChangeMe123!`

## Security notes
- In production, set `APP_SECRET` to a long random secret.
- New passwords must be at least 12 characters and include uppercase, lowercase, and numeric characters.
- Sessions expire after 8 hours.
- Repeated failed login attempts are rate limited.
- Sensitive identifiers are stored encrypted and only returned in masked form.
- Sensitive identifiers now use envelope encryption metadata (`keyId`, `alg`, `createdAt`, `ciphertext`) with key-provider backed rotation support and audited unmask policy checks.

## Testing
Run the production server contract test:

```bash
npm run test:contract
```

Run the smoke test:
Smoke test the full runtime:

```bash
npm run test:smoke
```

### One-command local validation

Prepare dependencies and local environment defaults:

```bash
npm run bootstrap:dev
```

Run the full master-aligned validation chain (syntax checks, runtime contract tests, smoke test, integration suites, and merge/main parity check):

```bash
npm run validate:master
```

`npm run test:all` remains available and now delegates to `validate:master`.

CI uses this same canonical gate (`npm run validate:master`) across supported Node versions (20 and 22), uploads gate logs plus parity/backup evidence artifacts, and exposes `required-status-checks` as the branch-protection-friendly merge check.
## Main parity check
Run the parity sync/report command:

```bash
npm run check:main-parity
```

Expected outputs:
- `OK: 'main' is fully merged into 'work'.` from `verify-main-merge.sh` plus `OK: 'work' is fully merged with 'main'.` when parity is complete (or a `MISSING:` line when work is behind)
- `artifacts/main-parity.json` containing `workBranch`, `mainBranch`, `mergeBase`, `aheadCount`, `behindCount`, and `missingCommitShas`

Run the standard integration coverage (tenancy, RBAC, templates, exports, portal lifecycle, analytics, and CSRF):

```bash
npm run test:integration
```

## Health checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl -I http://localhost:3000/health
```

Authenticated operational diagnostics:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/ops/diagnostics
```

## API shape
The supported runtime API is the plain Node server mounted under `/api`, for example:

```bash
curl -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo.test","password":"ChangeMe123!"}'
```
`/ready` now includes config validation output, SQLite quick-check results, export worker status summary, and audit event counts. `/api/ops/diagnostics` adds richer startup/runtime metadata for on-call troubleshooting.

Public runtime feature flags are available at `GET /api/runtime`.

## Portal view
Open `http://localhost:3000/portal?token=...` with a generated portal token to review shared client data, save drafts, and submit onboarding form responses.

## Backup
```bash
node scripts/backup-db.mjs
```
## Data location
Runtime data is stored in:
- `data/app.db`

Delete the file to reseed state. If `ENABLE_DEMO_MODE=true`, the demo dataset is seeded; otherwise startup state remains empty.

## Backups
```bash
node scripts/backup-db.mjs
node scripts/restore-db.mjs data/backup-<timestamp>.db
```

## Export worker
```bash
node scripts/export-worker.mjs
```

## Docker
```bash
docker compose --env-file .env up --build -d
```

See `DEPLOYMENT.md` for deployment details.

### PII key rotation utility

Run `node scripts/reencrypt-pii.mjs` to re-encrypt stored PII fields using the active key configured by `PII_ACTIVE_KEY_ID` and `PII_KEYRING`. Add `--validate` to assert that no legacy `*Ciphertext` values remain and all encrypted envelopes use the active key ID. The script returns one JSON object with rotation metrics (`rotatedProfiles`, `rotatedFields`, `activeKeyId`) and an optional `validation` block when requested.
