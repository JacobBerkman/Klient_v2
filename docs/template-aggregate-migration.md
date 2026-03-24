# Template Aggregate Migration

## Goal
Unify `formTemplates` and `documentTemplates` into one canonical `templateAggregates` collection while preserving API compatibility.

## Runbook
1. Create a DB backup and migrate:
   ```bash
   node scripts/migrate-template-aggregate.mjs
   ```
2. Validate:
   - `GET /api/forms/templates` still returns form templates.
   - `GET /api/templates` still returns document templates.
   - `GET /api/templates/:id/versions` returns version history.
   - `GET /api/templates/:id/publish-transitions` returns publish transitions.
   - Re-run migration script and confirm `"migrated": false` and `"idempotent": true`.

## Rollback notes
If rollback is required:
1. Stop writes to the API.
2. Restore from the backup file printed by `migrate-template-aggregate.mjs`:
   ```bash
   node scripts/restore-db.mjs <backup-file-path>
   ```
3. Restart API and verify `/api/health`.
4. Confirm compatibility projection counts in script output (`rollbackVerification.beforeLegacyCount`/`afterLegacyCount`).

## Data mapping summary
- `formTemplates[*]` → `templateAggregates[*]` with `kind: "form"`, `formSchema.sections`, and draft publish state.
- `documentTemplates[*]` → `templateAggregates[*]` with `kind: "document"`, `documentMetadata.fileName`, `blueprint`, `mappings`, versions, and publish state.
- Compatibility projections are API-boundary adapters only. Internal reads/writes must use `templateAggregates`.

## Deprecation status
- `state.formTemplates` and `state.documentTemplates` are **deprecated compatibility projections** and should not be used for internal business logic.
- `status` and `mappingRules` inside aggregate payloads are compatibility aliases; `publishState` and `mappings` are canonical.
