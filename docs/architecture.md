# Kinetic Klient Rebuild Architecture

## Product posture
Kinetic Klient now ships as a **single deployable Node application** backed by SQLite.
The runtime entrypoint is `apps/api/src/server.mjs`, and that server is responsible for:
- serving the JSON API,
- serving the advisor UI from `apps/web/public`,
- serving the client portal from `/portal`,
- persisting application state to `data/app.db`, and
- exposing health/readiness probes for operations.

## Runtime status
- **Canonical runtime:** `apps/api/src/server.mjs`
- **Frontend delivery:** static assets in `apps/web/public`
- **Persistence:** SQLite snapshot state plus read-optimized query tables in `data/app.db`
- **Background processing:** export jobs can be completed by `scripts/export-worker.mjs`
- **Removed duplication:** the unused Fastify/TypeScript prototype and related workspace scaffolding are no longer part of the repository

## Core backend capabilities
1. Authentication, firm bootstrap, invites, and password reset
2. Profiles, pipeline stages, notes, and dashboard reporting
3. Households, spouse linking, and member management
4. Form templates, drafts, submissions, and portal intake
5. Document templates, mapping auto-build, and export jobs
6. Audit history, analytics summaries, and masked sensitive-data access

## Security posture in the shipped runtime
- passwords must meet a minimum strength policy,
- sessions expire automatically,
- repeated failed logins are rate limited,
- firm scoping is enforced by the runtime store,
- and sensitive identifiers are encrypted at rest and exposed only as masked values.

## Operational model
- **Local start:** `node apps/api/src/server.mjs`
- **Smoke verification:** `node scripts/smoke-test.mjs`
- **Full validation:** `npm run test:all`
- **Container runtime:** `docker compose --env-file .env up --build -d`
