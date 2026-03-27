# Marketing Claim Roadmap

This document defines planned delivery milestones for user-facing claims that are currently marked `partial` or `roadmap`.

## Milestone M2: Draft collaboration hardening

- **Claim status target:** `implemented` ✅ (shipped on 2026-03-27).
- **Feature flag indicator:** `FF_DRAFT_CONFLICT_GUARD` (retired after rollout).
- **Scope:**
  - advisor/client concurrent edit conflict guardrails,
  - lock expiry recovery UX,
  - conflict resolution audit traces.
- **Exit criteria:**
  - integration coverage for concurrent edits ✅,
  - no unresolved SEV-1 defects in draft-save conflict handling ✅.

## Milestone M3: Export automation

- **Status:** `implemented` (completed 2026-03-27).
- **Claim status target:** move from `roadmap` to `implemented`.
- **Feature flag indicator:** `FF_EXPORT_AUTOMATION`.
- **Scope:**
  - queue-backed export orchestration,
  - retry-safe worker lifecycle,
  - downloadable export artifact tracking in advisor UI.
- **Exit criteria:**
  - smoke coverage includes successful export completion ✅,
  - queue + worker telemetry included in release evidence ✅.
