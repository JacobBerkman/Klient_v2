# Kinetic Klient Rebuild Architecture

## Product posture
This rebuild treats the current application as the behavioral reference while deliberately replacing its Replit-centric monolith structure with a portable platform design.

## Architectural decisions

### 1. Monorepo with explicit service and app boundaries
- `apps/api` will host the primary application API.
- `apps/web` will host the advisor/staff UI.
- `packages/domain` will hold shared contracts, enums, DTOs, and canonical workflow definitions.

### 2. Canonical template aggregate
The legacy split between `form_templates` and `templates`/`form_definitions`/`form_sections` is replaced by a single versioned template aggregate that owns:
- uploaded PDF metadata,
- extracted PDF fields,
- auto-built blueprint structure,
- manual edits in the builder/inspector,
- mapping rules,
- publish history.

### 3. Security-first backend policy
The API should enforce authorization server-side using:
- authenticated principal context,
- firm scoping middleware,
- policy checks by resource/action,
- audited sensitive field access,
- encryption services for PII,
- session lifecycle controls (single logout, logout-all, and admin-forced firm-user revocation),
- expiring invite and password-reset tokens with rejection on expiry.

### 4. Durable pipeline ordering
Prospect records should store a persisted per-stage `stageOrderIndex` so the Kanban board supports:
- stable ordering inside a stage,
- stable order when moving across stages,
- optimistic UI with rollback,
- deterministic analytics for stage aging and conversion funnels.

### 5. Replace browser-storage workflow hacks
Property and investment details should be draft-backed nested form flows instead of `sessionStorage` handoffs.

### 6. Background export architecture
Exports should be requested synchronously but processed asynchronously through a queue-backed worker. That worker should support retries, idempotency, and audit-friendly histories.

## Canonical backend modules
1. Auth + firms + invitations
2. CRM profiles + source attribution
3. Pipeline + stage history + analytics facts
4. Households + spouse linking
5. Forms + drafts + submissions
6. Templates + auto-build + mappings + versioning
7. Exports + document generation workers
8. Audit + compliance + sensitive data access logs
9. Reporting + analytics views

## Migration priorities
1. Build shared contracts and policies.
2. Unify templates/forms data model.
3. Introduce RBAC and firm enforcement everywhere.
4. Introduce encryption and masking services.
5. Add persisted Kanban ordering.
6. Complete repeatable item editing flows.
7. Move exports to worker processing.
