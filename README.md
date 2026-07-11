# Kinetic Klient Rebuild

This repository contains a **single-command runnable advisory onboarding app** with a plain Node.js HTTP server as the production backend, persistent SQLite storage, structured API logging, Docker packaging, health/readiness probes, backup/restore scripts, and end-to-end contract coverage for the main user flows.

## User-facing claim status (audited)

| Claim                                                                    | Status        | Notes                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advisory onboarding dashboard + prospects/clients/households/forms       | `implemented` | Fully available in current runtime.                                                                                                                                                                                                                   |
| Advisor analytics panels (funnel, stage aging, completion, productivity) | `implemented` | Available in advisor UI and analytics endpoints.                                                                                                                                                                                                      |
| Collaborative draft editing safeguards                                   | `implemented` | Conflict guard + lease recovery are now enforced across API + UI draft flows with integration coverage. See [Milestone M2](docs/milestones/claims-roadmap.md#milestone-m2-draft-collaboration-hardening).                                             |
| Queue-backed export/document automation                                  | `implemented` | Queue orchestration now includes retry-safe processing, dead-letter handling, machine-usable queue diagnostics, and verified artifact readiness/download flows. See [Milestone M3](docs/milestones/claims-roadmap.md#milestone-m3-export-automation). |

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
- canonical routed React/Vite web UI served by the backend from `apps/web/dist`
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
- the canonical routed React/Vite advisor and portal UI in `apps/web/src`, built to `apps/web/dist`
- `apps/web/public` is legacy-only and remains reachable only through `/legacy` and `/legacy/portal` until retirement

`apps/web/dist` is generated build output and is not committed to git: run `npm run web:build` after a fresh clone before serving the app with plain Node (Docker and CI build it themselves). Until it is built, the backend serves the legacy shell from `apps/web/public`.

The older duplicate Fastify/TypeScript backend path and related workspace scaffolding have been removed so the repository now has one real startup path.

## Product capabilities

- firm admin registration and sign-in
- persistent session-backed advisory workspace
- dashboard with recent activity and operating stats
- prospect/client creation, search, detail, notes, and stage management
- household creation, member management, and spouse linking/creation
- masked sensitive data handling for SSNs and tax IDs
- form template creation plus advisor and portal submission flows
- PDF document template ingestion with persisted source artifacts, AcroForm field extraction, linked generated form templates, and extraction diagnostics
- AcroForm visual mapper route with PDF preview, extracted field overlays, page navigation, drag/resize placement editing, test-fill preview, linked form visibility, and mapping/readiness checks
- template-driven export jobs that fill uploaded AcroForm PDFs when available, generate structured advisor XLSX workbooks, persist completed artifacts, and preserve retry/dead-letter queue behavior
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

Install root and web dependencies and create `.env` from `.env.example` when needed:

```bash
npm run bootstrap:dev
```

Run backend only:

```bash
npm run api:dev
```

Run the Vite frontend only:

```bash
npm run web:dev
```

Run backend, frontend, and the companion export worker together with prefixed logs:

```bash
npm run dev
```

Disable the local companion worker only when testing the deprecated manual recovery path:

```bash
DEV_EXPORT_WORKER=0 npm run dev
```

Build and preview the canonical web app:

```bash
npm run web:build
npm run web:preview
```

Open:

- API/static production server: `http://localhost:3000`
- Vite dev server: `http://127.0.0.1:5173`
- Client portal route: `/portal?token=<token>`
- Temporary legacy shell: `/legacy` and `/legacy/portal`

## Demo mode (optional, non-production only)

Set `ENABLE_DEMO_MODE=true` when running locally if you want seeded demo data and UI shortcuts.

Demo credentials (only when demo mode is enabled):

- Email: `admin@demo.test`
- Password: `ChangeMe123!`

## Security notes

- In production, set `APP_SECRET` to a long random secret.
- New passwords must be at least 12 characters and include uppercase, lowercase, and numeric characters.
- Sessions expire after 8 hours.
- User session authentication is cookie-only. Production/HTTPS uses `__Host-klient-session` and `__Host-klient-csrf`; local HTTP development uses `klient-session` and `klient-csrf` so browsers persist cookies correctly without weakening production security.
- Repeated failed login attempts are rate limited.
- Sensitive identifiers are stored encrypted and only returned in masked form.
- Sensitive identifiers now use envelope encryption metadata (`keyId`, `alg`, `createdAt`, `ciphertext`) with key-provider backed rotation support and audited unmask policy checks.

## Testing

Run the production server contract test:

```bash
npm run test:contract
```

Run the canonical frontend build gate:

```bash
npm run web:build
```

Smoke test the full runtime, including PDF template auto-build, generated form submission, worker processing, persisted PDF/XLSX artifacts, and downloads:

```bash
npm run test:smoke
```

Run only the minimal critical-path browser E2E suite (release-blocking tag):

```bash
E2E_GREP='@release-blocking' npm run test:e2e
```

Run the complete browser E2E suite:

```bash
npm run test:e2e
```

### E2E execution expectations (local + CI)

- Local:
  - `npm run test:e2e` runs UI contracts plus Playwright browser suites.
  - `E2E_GREP='@release-blocking' npm run test:e2e` runs only the release-blocking critical path.
  - Retries are disabled locally to fail fast.
- CI:
  - The `e2e release-blocking` workflow job installs Chromium and runs `E2E_GREP='@release-blocking' npm run test:e2e`.
  - Playwright retries are enabled in CI and traces/screenshots are captured only on failures for diagnostics.
  - Merge/release validation cannot pass unless the release-blocking E2E job is green.

### One-command local validation

Prepare dependencies and local environment defaults:

```bash
npm run bootstrap:dev
```

Run the full master-aligned validation chain (syntax/conflict guards, API contract tests, integration suites, migration checks, smoke test, UI contract checks, browser E2E checks, security checks, and merge/main parity check when available):

```bash
npm run validate:master
```

`npm run test:all` remains available and now delegates to `validate:master`.

For direct Node test runs (without npm scripts), use a test runtime env explicitly to avoid production-only startup guards:

```bash
NODE_ENV=test node --test apps/api/src/test/server-route-wiring.test.mjs
```

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

## Release operations (canonical flow)

For production release execution, use one source of truth: `docs/deployment-quick-reference.md#canonical-operator-flow-exact-command-sequence`.
That runbook defines preflight, deploy, postdeploy, and restore/restore-drill commands plus diagnostics interpretation.
Use `docs/release-ready-checklist.md` for pass/fail policy and approval gates, not for alternate command ordering.
Use `docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts` as the only source of truth for required evidence bundle contents and gate summary filenames.

`npm run release:go-no-go -- --release-id "$RELEASE_ID"` now automatically packages the default approver artifact at `artifacts/release-evidence/<release-id>/approval-bundle/` and prints the exact bundle path in command completion output.
Use that bundle directory (with `bundle-manifest.json`) as the primary file set for GO/NO-GO review circulation.

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
User-session API calls under `/api/*` authenticate via session cookies, while `/api/ops/*` accepts bearer auth via the rotation-safe ops token set (`KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, or legacy `KLIENT_OPS_TOKEN`).

Public runtime feature flags are available at `GET /api/runtime`.

## Template-to-export workflow

The canonical advisor workflow is implemented through the existing API and routed React UI:

1. Upload or auto-build a PDF document template at `/templates`.
2. The server extracts AcroForm fields, persists the original PDF artifact, creates a document template, and creates a linked generated form template when extraction succeeds.
3. Review extraction diagnostics, generated schema, mappings, linked form readiness, and export readiness on the template detail page.
4. Create a submission from the generated form in `/forms`.
5. Queue PDF or XLSX exports from `/templates/:templateId` or `/exports`.
6. The export worker fills the uploaded PDF template when possible, produces structured XLSX workbooks, stores completed artifact bytes, and exposes downloads from `/exports`.

If PDF extraction fails, the document template records explicit diagnostics and no linked form is created. Legacy/manual document templates without a source PDF can still use explicit summary fallback behavior, but source-backed templates do not fake success when the uploaded template cannot be used.

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
npm run exports:worker
```

The companion worker is the canonical queue processor for export jobs in local, Docker, and production deployments. `npm run dev` starts it automatically; `npm run exports:worker:once` runs one recovery/diagnostic tick. The admin `POST /api/exports/process` endpoint remains for recovery only and should not be used as the normal runtime path.

Completed PDF/XLSX artifacts are persisted to configured object storage metadata and downloaded from `GET /api/exports/:id/download`; old completed jobs without persisted objects retain a compatibility re-render fallback. Ops diagnostics expose `workerMode`, heartbeat timing, `workerObservedRecently`, and `pendingWithoutWorker` so operators can distinguish queued jobs waiting on a worker from actively processing jobs.

## Mapper MVP scope

The visual mapper is MVP-canonical for previewing source PDFs, reviewing extracted AcroForm overlays, editing placement with drag/resize or numeric coordinates, saving audited layout metadata, and generating temporary test-fill previews. Snapping, alignment guides, and bulk placement refinement are intentionally post-MVP; the export renderer remains AcroForm-field driven rather than layout-overlay driven.

## Docker

```bash
docker compose --env-file .env up --build -d
```

See `DEPLOYMENT.md` for deployment details.

### PII key rotation utility

Run `node scripts/reencrypt-pii.mjs` to re-encrypt stored PII fields using the active key configured by `PII_ACTIVE_KEY_ID` and `PII_KEYRING`. Add `--validate` to assert that no legacy `*Ciphertext` values remain and all encrypted envelopes use the active key ID. The script returns one JSON object with rotation metrics (`rotatedProfiles`, `rotatedFields`, `activeKeyId`) and an optional `validation` block when requested.

## Documentation freshness owner

- **Owner:** Release Operations (Release Manager + SRE primary).
- **Expectation:** update README links whenever release runbook command flow or runtime validation evidence requirements change.

## Repository extension points

- For repository interface scaffolding vs runtime adapter wiring, see `docs/repository-extension-points.md`.
