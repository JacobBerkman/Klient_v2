# RC Web Journey Acceptance Record — 2026-03-30

## Scope
Validated launch-critical journeys for:
- `apps/web/public/index.html` (admin bootstrap + advisor workflow completion)
- `apps/web/public/portal.html` (portal upload + form submission)

## Environment + Evidence Method
- **Requested target:** Live RC environment.
- **Execution reality:** No RC base URL or environment endpoint was provided in repository config or runtime environment variables at validation time, so browser-level live RC execution is currently **blocked**.
- **Compensating evidence captured:**
  1. Existing UI contract tests asserting accessibility wiring semantics.
  2. Smoke flow execution validating end-to-end journey-critical backend paths.
  3. Source review for focus, live regions, alert regions, and required-field focus behavior.

> Release handoff note: this record is attachable as release evidence and should be superseded by a real browser run once RC URL + credentials are available.

## Acceptance Outcomes (Pass/Fail)

### 1) Admin bootstrap journey (`index.html`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Keyboard navigation order through authentication panel and primary forms | **PASS (code + contract evidence)** | Semantic form controls and submit buttons are ordered in DOM; nav buttons are native `<button>` controls and tab-reachable. |
| Focus management on validation / errors | **PASS (code + contract evidence)** | Shared focus helpers (`focusLiveRegion`, missing field focus) are present and used by form feedback flow. |
| Status/error announcement behavior | **PASS (code + contract evidence)** | Auth status + form feedback regions use live-region semantics (`role=status`, `aria-live=polite`) and focus targeting for assertive error states. |

### 2) Advisor workflow completion (`index.html`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Workflow completion path available (profile/template/form/export orchestration) | **PASS (smoke evidence)** | Smoke test completes workflow API path creation and queue processing lifecycle checks. |
| Keyboard accessibility affordances on workflow controls | **PASS (contract evidence)** | Accessibility-critical semantics for navigation/board controls and exports keyboard labels are asserted in UI contract tests. |
| Status updates for workflow operations | **PASS (code + contract evidence)** | Feedback regions and focus behavior are asserted and wired for action results and errors. |

### 3) Portal upload + form submission (`portal.html`)

| Check | Outcome | Notes / Evidence |
|---|---|---|
| Keyboard navigation order for upload/form controls | **PASS (code evidence)** | Inputs/selects/buttons follow logical DOM sequence; template picker and submit/draft actions are keyboard reachable. |
| Focus management on invalid input and submit/upload errors | **PASS (code evidence)** | Invalid field focus (`focusFirstInvalidField`) and status/error region focus (`tabindex=-1` + focus option) are implemented. |
| Status/error announcement behavior | **PASS (code evidence)** | Separate polite status + assertive alert regions for both upload and form interactions are implemented and updated through unified helpers. |

## Remaining Non-Blocking UX/A11y Defects (Follow-up Tickets)

### Ticket UXA-241 — Add explicit skip link for main content on app shell
- **Priority:** P3 (Non-blocking)
- **Owner:** Web Frontend
- **Rationale:** Sidebar-first layout is keyboard navigable, but no explicit skip-to-content affordance is present for repeated nav bypass.
- **Acceptance criteria:**
  - A visible-on-focus skip link is first in tab order.
  - Skip link moves focus to top-level view heading/main content container.

### Ticket UXA-242 — Announce template change context in portal form builder
- **Priority:** P3 (Non-blocking)
- **Owner:** Web Frontend + QA Accessibility
- **Rationale:** Template picker updates visible sections; adding an explicit short live announcement for template change would reduce ambiguity for screen-reader users.
- **Acceptance criteria:**
  - On template switch, concise status update announces selected template name and field count.
  - Existing error/status behavior remains unchanged.

### Ticket UXA-243 — Add keyboard regression checklist to smoke/acceptance automation notes
- **Priority:** P2 (Non-blocking, process)
- **Owner:** QA Automation
- **Rationale:** Current smoke validates backend journey integrity but does not execute browser-level keyboard traversal assertions.
- **Acceptance criteria:**
  - Release checklist includes required RC browser run covering tab order and focus return.
  - Evidence artifact contains explicit keyboard path steps + pass/fail marks.

## Release Handoff Attachment
- Attach this file into the release handoff package under:
  - `docs/rc-web-journeys-acceptance-2026-03-30.md`
- Link from handoff evidence section as:
  - **UX/accessibility acceptance record (RC journeys)**
