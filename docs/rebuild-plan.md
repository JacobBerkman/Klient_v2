# Rebuild Plan

## Phase 1 — Foundation
- Establish workspace boundaries.
- Define canonical shared domain types.
- Document module ownership and migration targets.
- Introduce policy-first RBAC and firm scoping.

## Phase 2 — Canonical workflows
- Consolidate templates and form definitions into one aggregate.
- Model persisted prospect pipeline ordering.
- Normalize source attribution as a structured domain object.
- Add durable draft-backed repeatable item editing.

## Phase 3 — Security and portability
- Replace Replit-specific auth and storage.
- Add portable identity provider abstraction.
- Implement encryption, masking, CSRF protections, and sensitive-read audits.

## Phase 4 — Jobs and analytics
- Move exports and document processing into queue-backed workers.
- Add funnel, stage aging, and completion analytics.
- Add predictable seeds, CI, tenancy tests, and RBAC regression coverage.
