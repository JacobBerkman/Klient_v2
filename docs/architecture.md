# Kinetic Klient Rebuild Architecture

## Runtime entrypoint
- `apps/api/src/server.mjs` owns process startup and graceful shutdown.
- HTTP wiring is created via `createHttpServer({ modules })`.
- Routes remain thin: each route performs request parsing, authentication, **policy check**, and a single module service call.

## Module-first backend layout
Domain modules live under `apps/api/src/modules/*`:
- `auth`
- `firms-users`
- `profiles`
- `pipeline`
- `households`
- `forms`
- `templates`
- `exports`
- `audit`
- `analytics`

Each module exposes `service.mjs` and is composed in `apps/api/src/modules/index.mjs`.

## Layering model

### 1) Transport layer (HTTP)
- File: `apps/api/src/server.mjs`
- Responsibilities:
  - HTTP request/response handling
  - auth token extraction
  - CSRF validation
  - route-level policy checks
  - invoking module services

### Request logging redaction
- `request.completed` and `request.failed` logs now emit a sanitized `path` value.
- By default, only the URL pathname is logged (query strings are omitted).
- If `LOG_REQUEST_QUERY=true`, query strings are included with filtering:
  - known sensitive keys (`token`, `code`, `session`, `secret`) are replaced with `[REDACTED]`
  - non-allowlisted keys are replaced with `[OMITTED]`
  - safe allowlisted keys (for example `kind`, `search`, `page`, `limit`) retain values for debugging
- Operational expectation: responders should not expect raw auth/session query values in production request logs; request IDs remain the primary correlation key.

### 2) Service layer (domain modules)
- Files: `apps/api/src/modules/*/service.mjs`
- Responsibilities:
  - domain use-cases per bounded module
  - orchestration across repositories
  - no direct HTTP concerns

### 3) Repository layer (persistence ports + adapters)
- Interfaces:
  - `apps/api/src/modules/profiles/repository.mjs` (`ProfileRepository`)
  - `apps/api/src/modules/templates/repository.mjs` (`TemplateRepository`)
  - `apps/api/src/modules/exports/repository.mjs` (`ExportsRepository`)
- Adapters:
  - `apps/api/src/repositories/store-adapters.mjs`
  - Export queue orchestration adapter: `apps/api/src/modules/exports/store-repository.mjs`

### 4) Runtime storage implementation
- Current stateful runtime remains in `apps/api/src/store.mjs`.
- Repository adapters bridge module services to legacy state logic during migration.
- Export queue orchestration (queue list/create/retry/process + bulk retry + health snapshot) is now extracted from `store.mjs` into `modules/exports/store-repository.mjs`, with `store.mjs` retaining thin permission-checked delegation methods for backward compatibility.
- Intentional compatibility layer retained: `POST /api/exports/process` remains available as a controlled fallback for operator-driven queue drain/recovery, while release-blocking validation now executes the canonical `scripts/export-worker.mjs` worker path.

## Incremental migration delta (Task 9)
- **Chosen high-churn domain:** exports queue lifecycle (`/api/exports`, `/api/exports/process`, retry endpoints).
- **What moved now:** export orchestration logic moved behind explicit module/repository boundaries:
  - Module service now depends on `ExportsRepository` instead of directly mutating `store`.
  - A dedicated store-backed repository (`modules/exports/store-repository.mjs`) owns queue orchestration and state persistence coordination.
  - `store.mjs` export methods became thin delegators, avoiding additional direct-mutation growth in transport/module layers.
- **What did not change:** API routes in `server.mjs` remain thin transport handlers and keep policy checks + single service calls.
- **Why incremental:** this avoids a big-bang rewrite by preserving existing state shape and endpoint contracts while isolating a churn-heavy domain behind repository seams for future persistence swaps.

## Dependency rules
1. `server.mjs` may depend on module services and policy helpers, but must not implement business rules.
2. Module services may depend on repository interfaces and cross-cutting policy abstractions.
3. Repository adapters may depend on storage/runtime implementations (`store`, sqlite read models).
4. Repository interfaces must not depend on concrete adapters.
5. Modules should not import from other modules' internals; use composition in `modules/index.mjs`.
6. Direct domain mutation is disallowed in `server.mjs`.

## Testing strategy
- Keep behavior parity with existing API contracts.
- Add wiring-focused integration tests that assert route -> policy -> service invocation order.
- Continue using smoke/integration scripts for end-to-end behavior.

## Operational commands
- Start: `node apps/api/src/server.mjs`
- Wiring tests: `node --test apps/api/src/test/server-route-wiring.test.mjs`
- Smoke: `node scripts/smoke-test.mjs`

## ADR references
- Canonical template domain model: `docs/architecture/template-domain-adr.md`
- Domain modernization sequencing addendum: `docs/architecture/domain-modernization-adr-addendum.md`
