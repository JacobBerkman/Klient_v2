# Profile Core Fields Migration Plan

## Goal
Move frequently queried profile attributes from loosely typed payload data to typed core fields, and standardize firm-specific custom data under an `extensions` object.

## Scope
- Core typed fields:
  - contact: `email`, `phone`
  - status: `status`
  - source: `source.cityOrLocation`, `source.venue`, `source.occurredOn`
  - household refs: `householdId`, `spouseClientId`
  - financial summary primitives: `financialSummary.investableAssets`, `annualIncome`, `totalAssets`, `totalLiabilities`, `netWorth`
- Custom fields:
  - migrate `customProfile` to `extensions.values`
  - include schema metadata: `extensions.schemaVersion`, optional `extensions.schema`

## Database rollout
1. Deploy code that adds nullable profile columns and backfills them from profile payload during `saveState`.
2. Keep payload as source-of-truth compatibility layer while query paths move to typed columns.
3. Add optional `status` filtering on profile list endpoint to validate typed status indexing behavior in production traffic.

## Data migration
Run:

```bash
node scripts/backfill-profile-core-fields.mjs
```

The script:
- normalizes `extensions` for every profile,
- computes `financialSummary` with typed-first values and extension fallback,
- sets default status (`active` for clients, `new` for prospects),
- removes legacy `customProfile`,
- prints a verification report.

## Verification
Use script output and confirm:
- `verification.withoutExtensions === 0`
- `verification.withoutFinancialSummary === 0`
- `verification.withoutStatus === 0`

If non-zero, stop rollout and inspect profiles with malformed payloads before continuing.

## Rollback
- Revert application deploy.
- Restore database snapshot from pre-migration backup.
- Re-run older code path (payload-only behavior) until issue is resolved.
