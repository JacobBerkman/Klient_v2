# Template Unification Migration (Legacy -> Canonical Templates V2)

## Goal

Copy legacy `formTemplates` and `documentTemplates` data into the canonical `templateAggregates` model in controlled stages while preserving rollback safety.

## Script

Use:

```bash
node scripts/migrate-template-unification.mjs --stage=<stage>
```

Stages:

- `plan` (default): report counts, duplicates, and no-op status
- `backfill`: copy missing legacy templates into canonical aggregates
- `verify`: assert canonical contains all legacy IDs
- `project-legacy`: regenerate compatibility projections from canonical

## Recommended execution order

1. Backup current data state.
2. Run `plan` and review output.
3. Run `backfill`.
4. Run `verify`.
5. Run `project-legacy`.
6. Re-run `plan` to ensure idempotent/no-op behavior.

## Rollback strategy

If any stage fails validation:

1. Stop writes to template/form endpoints.
2. Restore from the backup file produced before migration (`node scripts/backup-db.mjs`).
3. If restore is not available, run `node scripts/restore-db.mjs <backup-file>`.
4. Re-run `plan` to confirm legacy/canonical counts match pre-migration values.

## Success criteria

- Every legacy template ID appears in canonical `templateAggregates`.
- Legacy endpoint payloads remain unchanged in shape.
- Re-running `backfill` is idempotent (zero newly copied records).
