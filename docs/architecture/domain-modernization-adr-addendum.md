# ADR Addendum: Domain Modernization Sequencing and Coexistence Contracts

- **Status:** Accepted
- **Date:** 2026-03-25
- **Supersedes/extends:** `docs/architecture/template-domain-adr.md`
- **Deciders:** API, Data Platform, Security

## Purpose

Define a practical, releasable modernization path that preserves delivery velocity for production-critical fixes (security/auth/template/export) while continuing migration from legacy runtime storage to explicit domain services and repository adapters.

## 1) Target-state domains and migration intent

The target architecture remains module-first, with each domain owned by a service contract and persistence behind repository interfaces.

### Domain targets and why/when to migrate

1. **Auth + Session domain** (`auth`)
   - **Why:** highest security blast radius; currently intersects CSRF, cookies, and token/session validation.
   - **When:** migrate first where extraction reduces security risk without changing external API semantics.
2. **Templates + Forms domain** (`templates`, `forms`)
   - **Why:** canonical template aggregate is established; parallel legacy structures still create drift risk.
   - **When:** continue staged migration after auth/session seams are stable; prioritize endpoints with dual-write/read adaptation already in place.
3. **Exports domain** (`exports`)
   - **Why:** high operational churn and queue behavior; already partially isolated via module + store-backed repository.
   - **When:** migrate in early/mid phases to reduce incident-prone queue orchestration in shared runtime store.
4. **Profiles/Pipeline/Households domain cluster** (`profiles`, `pipeline`, `households`)
   - **Why:** broad business surface but lower immediate security urgency; benefits from proven adapter pattern.
   - **When:** sequence after auth/templates/exports patterns are operationally proven.
5. **Audit + Analytics domain** (`audit`, `analytics`)
   - **Why:** cross-cutting and read-model heavy; lower user-facing risk for delayed migration.
   - **When:** final phase, after upstream write-path contracts stabilize.

## 2) Migration seams already present + phase order by churn/risk

### Existing seams

- **Module service boundaries** already exist under `apps/api/src/modules/*/service.mjs`.
- **Repository interfaces/adapters** already exist for key domains (`profiles`, `templates`, `exports`) and store adapters.
- **Transport layer thinness** in `server.mjs` already enforces policy+service-call routing, enabling backend replacement without route rewrites.

### Phase order rubric

Order migration work by:

- **Churn:** frequency of production edits/incidents.
- **Risk:** security, data integrity, and rollback complexity.
- **Seam readiness:** existence of module/repository abstraction already deployed.

### Assigned phases

- **Phase A (highest risk + ready seam):** Auth/session extraction hardening.
- **Phase B (high churn + ready seam):** Exports isolation completion.
- **Phase C (high complexity + canonical model available):** Templates/forms convergence completion.
- **Phase D (broad surface):** Profiles/pipeline/households adapter rollout.
- **Phase E (stabilization/read models):** Audit/analytics persistence and reporting isolation.

## 3) Coexistence contracts (required during all phases)

1. **Shared API shape contract**
   - No client-visible route/response breaking changes during modernization increments.
   - New domain internals must conform to existing transport DTOs unless explicitly versioned.
2. **Dual-path persistence + backfill idempotency contract**
   - Backfills and migration jobs must be idempotent (safe to rerun without duplicating/overwriting valid terminal state).
   - Dual-read/dual-write periods must declare source-of-truth precedence and reconciliation rules.
3. **Rollback trigger contract**
   - Immediate rollback if any of the following occur after cutover:
     - auth/session validation regression,
     - template publish/version parity mismatch,
     - export queue correctness/SLA degradation,
     - non-recoverable data divergence between legacy and new stores.
   - Every increment must include a documented rollback command/procedure before release approval.

## 4) Narrow, releasable modernization increments

Each increment must ship independently behind existing API contracts.

1. **Auth/session service extraction (Phase A)**
   - Move cookie/session token lifecycle logic behind explicit auth repository/service seams.
   - Keep existing `/api/auth*` contract unchanged.
2. **Export worker isolation (Phase B)**
   - Finalize queue orchestration behind exports repository; isolate process/retry paths from shared store mutation points.
   - Preserve existing `/api/exports*` semantics and health snapshot behavior.
3. **Templates/forms persistence adapter swap (Phase C)**
   - Keep canonical template aggregate as domain source of truth while progressively replacing legacy projection dependencies.
   - Maintain endpoint parity for `/api/templates*` and `/api/forms/templates*`.
4. **Profiles/pipeline adapter introduction (Phase D)**
   - Introduce repository adapters for highest-change profile/pipeline write paths first.
   - Limit each release to one bounded use-case slice (e.g., stage transition writes only).

## 5) Go / No-Go criteria (non-blocking guardrails)

Modernization work **must not block** production fixes in security/auth/template/export paths.

### Go criteria for a modernization increment

- Has a reversible release plan (feature flag or deploy-time switch) and tested rollback.
- Demonstrates parity on affected endpoint contracts and authorization behavior.
- Includes idempotent migration/backfill validation where persistence changes are introduced.
- Does not increase unresolved Sev-1/Sev-2 incidents in touched domains.

### No-Go criteria (defer modernization; prioritize production fixes)

- Active Sev-1/Sev-2 issue in security/auth/template/export domains.
- Failed parity, auth policy regression, or export correctness regression in validation checks.
- Missing rollback procedure or inability to complete rollback within operational SLO.
- Migration task scope expands beyond a narrow releasable slice.

### Priority override rule

If conflict occurs between modernization scope and a production-critical fix, the modernization increment is paused or reduced to preserve immediate delivery of the production fix. This rule is mandatory for all phases.
