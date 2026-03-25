# Route → Guard → Store Permission Map

This matrix documents the runtime path for each guarded API route: HTTP endpoint, policy guard in `policy-matrix.json`, and the underlying store permission assertion.

| Endpoint | Guard | Underlying permission call |
|---|---|---|
| GET `/api/ops/diagnostics` | `canReadDiagnostics` | `diagnostics:read` (analytics diagnostics context) |
| GET `/api/ops/exports/queue` | `canReadExports` | `exports:read` |
| POST `/api/ops/exports/retry-failed` | `canWriteExports` | `exports:write` |
| GET `/api/runtime` | `canAccessRuntime` | n/a (no store permission) |
| POST `/api/register` | `canRegister` | n/a |
| POST `/api/login` | `canLogin` | n/a |
| POST `/api/invites` | `canManageUsers` | `users:manage` |
| POST `/api/invites/accept` | `canAcceptInvite` | n/a |
| POST `/api/password-resets` | `canRequestPasswordReset` | n/a |
| POST `/api/password-resets/confirm` | `canConfirmPasswordReset` | n/a |
| POST `/api/auth/mfa/*` | `canReadSession` | n/a |
| GET `/api/users` | `canReadUsers` | `users:read` |
| GET `/api/session` | `canReadSession` | n/a |
| GET `/api/dashboard` | `canViewDashboard` | `dashboard:read` |
| GET `/api/profiles` | `canReadProfiles` | `profiles:read` |
| POST `/api/profiles` | `canWriteProfiles` | `profiles:write` |
| GET `/api/profiles/:id` | `canReadProfiles` | `profiles:read` + tenant ownership validation |
| PATCH `/api/profiles/:id` | `canWriteProfiles` | `profiles:write` + tenant ownership validation |
| GET `/api/profiles/:id/stage-history` | `canReadProfiles` | `pipeline:read` |
| GET `/api/profiles/:id/notes` | `canReadProfiles` | `profiles:read` |
| POST `/api/profiles/:id/notes` | `canWriteProfiles` | `profiles:write` + tenant ownership validation |
| PATCH `/api/profiles/:id/stage` | `canMovePipeline` | `pipeline:write` + tenant ownership validation |
| PATCH `/api/pipeline/reorder` | `canMovePipeline` | `pipeline:write` + tenant ownership validation |
| GET `/api/board` | `canReadProfiles` | `pipeline:read` |
| GET `/api/households` | `canReadHouseholds` | `households:read` |
| POST `/api/households` | `canWriteHouseholds` | `households:write` + tenant ownership validation |
| POST `/api/households/:id/members` | `canWriteHouseholds` | `households:write` + tenant ownership validation |
| DELETE `/api/households/:id/members` | `canWriteHouseholds` | `households:write` + tenant ownership validation |
| POST `/api/households/link-spouse` | `canWriteHouseholds` | `households:write` + tenant ownership validation |
| POST `/api/households/create-spouse` | `canWriteHouseholds` | `households:write` |
| GET `/api/forms/templates` | `canReadForms` | `forms:read` |
| POST `/api/forms/templates` | `canWriteForms` | `forms:write` |
| GET `/api/forms/submissions` | `canReadForms` | `forms:read` |
| GET `/api/forms/drafts` | `canReadForms` | `forms:read` |
| POST `/api/forms/submissions` | `canWriteForms` | `forms:write` |
| PATCH `/api/forms/submissions/:id` | `canWriteForms` | `forms:write` + tenant ownership validation |
| DELETE `/api/forms/submissions/:id` | `canWriteForms` | `forms:write` + tenant ownership validation |
| GET `/api/client/workspace` | `canReadClientWorkspace` | `portal:read` |
| POST `/api/client/forms/submissions` | `canWriteClientWorkspace` | `client:write` |
| POST `/api/client/uploads` | `canWriteClientWorkspace` | `client:write` |
| POST `/api/client/uploads/presign` | `canWriteClientWorkspace` | `client:write` |
| GET `/api/templates` | `canReadTemplate` | `templates:read` |
| POST `/api/templates` | `canEditTemplate` | `templates:write` |
| POST `/api/templates/auto-build` | `canEditTemplate` | `templates:write` |
| POST `/api/templates/:id/mappings` | `canEditTemplate` | `templates:write` + tenant ownership validation |
| POST `/api/templates/:id/publish` | `canPublishTemplate` | `templates:write` + tenant ownership validation |
| GET `/api/templates/:id/versions` | `canReadTemplate` | `templates:read` + tenant ownership validation |
| GET `/api/templates/:id/publish-transitions` | `canReadTemplate` | `templates:read` + tenant ownership validation |
| GET `/api/templates/:id/compare` | `canReadTemplate` | `templates:read` + tenant ownership validation |
| POST `/api/templates/:id/revert` | `canEditTemplate` | `templates:write` + tenant ownership validation |
| GET `/api/exports` | `canReadExports` | `exports:read` |
| POST `/api/exports` | `canWriteExports` | `exports:write` |
| POST `/api/exports/process` | `canProcessExports` | n/a (service-level processing) |
| POST `/api/exports/:id/retry` | `canWriteExports` | `exports:write` + tenant ownership validation |
| GET `/api/audit` | `canReadAudit` | `audit:read` |
| GET `/api/analytics` | `canReadAnalytics` | `analytics:read` |
| GET `/api/analytics/dashboard` | `canReadAnalytics` | `analytics:read` |
| GET `/api/analytics/export` | `canReadAnalytics` | `analytics:read` |
| GET `/api/profiles/:id/sensitive` | `canReadSensitiveProfileData` | `sensitive:read` + tenant ownership validation |
| POST `/api/portal-links` | `canCreatePortalLink` | `portal:manage` + tenant ownership validation |
| POST `/api/portal-links/:id/revoke` | `canCreatePortalLink` | `portal:manage` + tenant ownership validation |
| GET `/api/portal/:token` | `canReadPortal` (token scope) | n/a (token-scoped) |
| POST `/api/portal/:token/submissions` | `canSubmitPortal` (token scope) | n/a (token-scoped) |
| POST `/api/portal/:token/uploads/presign` | `canUploadPortal` (token scope) | n/a (token-scoped) |
| POST `/api/portal/:token/uploads` | `canUploadPortal` (token scope) | n/a (token-scoped) |

## Resolved mismatch notes

- User management now maps to explicit `users:read` / `users:manage` store permissions.
- Dashboard access maps to `dashboard:read` instead of reusing profile read.
- Forms, households, pipeline, audit, and sensitive-data flows now use domain-specific read permissions.
- Cross-tenant entity access now uses explicit ownership validation instead of relying solely on implicit `firmId` filtering.
- Denied RBAC access uses HTTP 403; cross-tenant entity denial uses HTTP 404.
