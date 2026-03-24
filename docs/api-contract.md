# API Contract (Canonical Node Runtime)

This document defines the stable API contract for the shipped Node runtime at `apps/api/src/server.mjs`.

## Runtime and versioning policy

- Canonical runtime: `node apps/api/src/server.mjs`
- Stable base paths:
  - Legacy compatibility: `/api/*`
  - Versioned contract path: `/api/v1/*`
- Contract discovery endpoint:
  - `GET /api/contract`
  - `GET /api/v1/contract` (versioned envelope)

`/api/v1/*` is the long-term stable shape. `/api/*` remains available to avoid breaking existing clients.

## Authentication expectations

Most business endpoints require a bearer token from login/register sessions.

- Header: `Authorization: Bearer <session-token>`
- Session token endpoints:
  - `POST /api/login` or `POST /api/v1/login`
  - `POST /api/register` or `POST /api/v1/register`

Error behavior:

- Missing or invalid token: `401` + error code `AUTH_REQUIRED`
- Missing role/permission: `403` + error code `FORBIDDEN`

## Stable error shape

All API failures now return this shape:

```json
{
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication required.",
    "status": 401,
    "requestId": "...",
    "details": {}
  },
  "message": "Authentication required.",
  "meta": {
    "apiVersion": "v1",
    "requestId": "..."
  }
}
```

Notes:
- `details` is optional.
- `message` is duplicated at the top level for compatibility with existing callers.
- `X-Request-Id` and `X-API-Version: v1` headers are included on API responses.

## Stable success envelope (`/api/v1/*`)

Versioned endpoints return:

```json
{
  "data": {},
  "meta": {
    "apiVersion": "v1",
    "requestId": "..."
  }
}
```

Legacy `/api/*` success payloads keep previous direct shapes.

## Key resource payloads

Key advisory workflows retain these canonical payload structures:

- Session (`/api/login`, `/api/register`):
  - `token`, `user` (`id`, `firmId`, `email`, `firstName`, `lastName`, `role`)
- Profiles/prospects/clients (`/api/profiles*`):
  - identity fields + `kind`, `stage`, `stageOrderIndex`, `source`, timestamps
- Households (`/api/households*`):
  - `id`, `firmId`, `name`, `primaryClientId`, `createdAt`
- Form templates/submissions (`/api/forms/*`):
  - template metadata + section/field arrays and submission status/data
- Document templates/exports (`/api/templates*`, `/api/exports*`):
  - template mappings/publish state and export status lifecycle
- Audit (`/api/audit`):
  - `id`, `firmId`, actor, entity, action, timestamp, metadata

## Firm isolation and permissions

The runtime enforces firm-scoped access and role permission checks in the store layer:

- Data is always filtered by authenticated `firmId`
- Permission checks gate write and sensitive read operations
- Violations produce stable error codes (`AUTH_REQUIRED`, `FORBIDDEN`)

## Upgrade guidance

- New integrations should target `/api/v1/*`.
- Existing UI code using `/api/*` can migrate incrementally.
- Any new endpoint should expose the versioned path and return:
  - stable error shape,
  - versioned success envelope on `/api/v1/*`,
  - existing unversioned shape on `/api/*` if backwards compatibility is needed.
