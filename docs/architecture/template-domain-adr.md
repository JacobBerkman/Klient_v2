# ADR: Canonical Template Domain Model (Templates V2)

- **Status:** Accepted
- **Date:** 2026-03-25
- **Deciders:** API + Data Platform teams

## Context

The platform currently has two template systems:

1. legacy manually-authored document templates (`documentTemplates`)
2. auto-build/template extraction flows exposed through existing template/form endpoints

In parallel, form templates (`formTemplates`) hold schema data that overlaps with document template mapping and lifecycle concerns. This split causes duplicated logic, migration overhead, and drift in publish/version behavior.

## Decision

Adopt a **single canonical template aggregate** (Templates V2) as the only domain model for template authoring and execution.

Each aggregate owns:

- uploaded document template metadata (`documentMetadata`)
- extracted PDF fields (`extractedFields`)
- form definition schema (`formSchema`) including sections, fields, repeaters, and conditional rules
- mapping rules (`mappings`)
- version lifecycle (`versions`, `publishState`, and transition history)

Canonical shape (high-level):

```json
{
  "id": "uuid",
  "firmId": "uuid",
  "kind": "document | form",
  "name": "string",
  "description": "string",
  "documentMetadata": { "fileName": "string|null", "storageKey": "string|null" },
  "extractedFields": ["string"],
  "formSchema": {
    "sections": [
      {
        "id": "string",
        "title": "string",
        "fields": [{ "id": "string", "type": "string" }],
        "repeaters": [{ "id": "string", "itemSchema": {} }],
        "conditionalRules": [{ "when": {}, "then": {} }]
      }
    ]
  },
  "mappings": [{ "pdfField": "string", "sourcePath": "string" }],
  "publishState": "draft | published | archived",
  "versions": [{ "version": 1, "event": "created", "createdAt": "iso-date" }],
  "publishTransitions": [{ "from": "draft", "to": "published", "at": "iso-date" }],
  "legacy": { "source": "documentTemplates|formTemplates", "id": "legacy-id" }
}
```

## Compatibility Strategy

Legacy API contracts remain stable during migration:

- `/api/templates*` adapters read/write canonical aggregates with `kind=document`
- `/api/forms/templates*` adapters read/write canonical aggregates with `kind=form`
- old legacy arrays/tables remain as compatibility projections until cutover is complete

## Consequences

### Positive

- One source of truth for template metadata, schema, mappings, and lifecycle
- Consistent versioning + publish semantics
- Safer staged migration with idempotent backfills

### Tradeoffs

- Short-term adapter complexity while old tables coexist
- Additional migration/rollback procedures required before dropping legacy structures

## Rollout

1. Introduce Templates V2 domain module and compatibility adapters.
2. Run staged migration/backfill from legacy tables into canonical aggregates.
3. Verify endpoint parity and idempotency.
4. Cut reads to canonical-only, then retire legacy tables in a later release.
