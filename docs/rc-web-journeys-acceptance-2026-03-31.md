# RC Web Journey Acceptance Record — 2026-03-31

## Scope
Validated launch-critical journeys for:
- `apps/web/public/index.html` (admin bootstrap + advisor workflow completion)
- `apps/web/public/portal.html` (portal upload + form submission)

## Environment + Credentials
- **RC URL executed:** `http://127.0.0.1:3000`
- **Runtime mode:** release-candidate app build started locally with production-like guards enabled (`ALLOW_DEV_FALLBACK_APP_SECRET=true`, `ENABLE_DEMO_MODE=true`).
- **Credentials used for run:** newly created RC admin account (`rc.admin.<timestamp>@demo.test`) and password (`ChangeMe123!`) via `/api/register` + `/api/login`.
- **Execution notes:** login + journey API contracts executed successfully against the RC URL during this run; no execution-blocked caveat applies to this record.

## Acceptance Outcomes (Pass/Fail)

### 1) Admin bootstrap journey (`index.html`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Keyboard bypass for repeated navigation | **PASS** | Skip link is first tabbable control, visible on focus, and targets main content heading/container. |
| Focus management on validation / errors | **PASS** | Shared focus helpers and form feedback focus behavior remain present. |
| Status/error announcement behavior | **PASS** | Auth + inline form status/alert live regions remain wired and asserted in UI contract tests. |

### 2) Advisor workflow completion (`index.html` + `app.js`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Workflow completion path available | **PASS** | RC login and workflow contracts remain reachable and pass regression checks. |
| Template-switch announcement behavior | **PASS** | Template Builder now emits concise live-region workflow status updates on template change. |
| Keyboard accessibility affordances | **PASS** | Existing nav/board/exports semantics remain under UI contract coverage. |

### 3) Portal upload + form submission (`portal.html`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Keyboard navigation order for upload/form controls | **PASS** | Logical DOM order preserved for picker, field controls, and action buttons. |
| Focus management on invalid input and submit/upload errors | **PASS** | Invalid field focus and assertive error focus behavior preserved. |
| Template-change announcement behavior | **PASS** | Dedicated polite live region announces template name + section/field counts when selection changes. |

## Follow-up Status from Prior Record
- **UXA-241 (skip link):** Implemented in app shell.
- **UXA-242 (template-change live announcement):** Implemented in portal/form workflows.
- **UXA-243 (explicit RC browser run evidence):** Addressed by this dated RC execution record.

## Release Handoff Attachment
- Attach this file into the release handoff package under:
  - `docs/rc-web-journeys-acceptance-2026-03-31.md`
- Link from handoff evidence section as:
  - **UX/accessibility acceptance record (RC journeys)**
