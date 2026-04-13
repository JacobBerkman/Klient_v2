# Release Candidate Preserved-Flow Test Matrix

## Purpose
Define the minimum deterministic automation matrix that must pass before freezing a release candidate (RC).

## Canonical browser release gate

The canonical browser gate is `npm run test:e2e`. It executes UI contract checks first, then Playwright browser tests, and always writes:

- `artifacts/release-evidence/<release-id>/e2e-summary.json`
- `artifacts/release-evidence/<release-id>/playwright-report.json`

Deterministic guarantees in this path:

- fixed host/port from `createTestContext` (`http://127.0.0.1:<deterministic-port>`),
- isolated reset behavior default (`TEST_RESET_BEHAVIOR=isolated`),
- strict CI behavior (local fallback is ignored whenever `CI=true`).

CI gate policy:

- Browser provisioning is performed in `.github/workflows/smoke.yml` via `npx playwright install --with-deps chromium` before browser execution in both `hard_release_gate` (`npm run validate:master`) and `e2e_release_blocking` (`npm run test:e2e`).
- `e2e_release_blocking` is the authoritative release-blocking browser job for merge/release decisions; `hard_release_gate` exists to keep the canonical `validate:master` path parity-tested with the same provisioning expectations.

## Preserved flow to deterministic test mapping

| Preserved flow | Deterministic automated test(s) | Why this is the primary gate |
|---|---|---|
| Admin bootstrap (register + login + dashboard landing) | `npx playwright test tests/e2e/workflows.spec.mjs --grep "admin bootstrap registration and login remain stable"` | End-to-end UI + API workflow with deterministic seeded IDs validates bootstrap and authentication path in one run. |
| Advisor workflow completion (template map → preflight remediation → publish) | `npx playwright test tests/e2e/workflows.spec.mjs --grep "template upload/map/preflight/publish loop executes with issue remediation controls"` | Deterministically covers the preserved advisor authoring journey including remediation controls and publish readiness gates. |
| Portal upload and submit lifecycle (draft → submitted) | `npx playwright test tests/e2e/workflows.spec.mjs --grep "portal draft then submit lifecycle is stable"` | Explicitly verifies the preserved portal submission lifecycle; retries are scoped only to this known transient-infra slice in CI. |
| Release smoke journey (health/ready + profile/template/submission/export path) | `npm run test:smoke` | Validates the canonical production smoke path and writes release evidence in the canonical schema. |

## Targeted gap-fill strategy (avoid broad duplicate suites)

1. Run the three flow-specific Playwright tests above individually (`--grep`) instead of full-suite duplicate runs.
2. Keep smoke coverage in `npm run test:smoke` as the cross-module path check.
3. Use `npm run test:integration` once as the aggregated integration gate; do not add a second full integration pass unless a failure requires rerun after a fix.

## Operator runbook notes (mapping/preflight diagnostics)

Use this when triaging template publish readiness evidence during RC validation:

- In **Step 2 · Extraction Summary**, confirm extracted/mapped/unmapped counts and use **Review unmapped in mapping** to jump directly into unresolved rows.
- In **Step 3 · Mapping**, use per-row suggestion confidence and **Apply** actions to capture deterministic remediation evidence for source-path fixes.
- For source-path/transform rollback proof, use **Clear source path** and **Reset transform to none** in **Field Inspector**, then rerun Save + Preview.
- In **Step 5 · Publish**, use row jump actions from preflight issue lists/remediation rows to close the “issue found → row fixed → preflight rerun” loop.
- Attach the result of the deterministic flow test command below to the release handoff evidence set:
  - `npx playwright test tests/e2e/workflows.spec.mjs --grep "template upload/map/preflight/publish loop executes with issue remediation controls"`

## Cross-cutting regression gates

Run these after targeted preserved-flow checks:

- `npm run test:contract`
- `npm run test:security`

Both must pass with release evidence artifacts generated under `artifacts/release-evidence/<release-id>/`.

## Release evidence naming and location conventions

Required conventions:

- Directory root: `artifacts/release-evidence/<release-id>/`
- Gate summaries:
  - `api-contract-summary.json`
  - `integration-summary.json`
  - `smoke-summary.json`
  - `security-summary.json`
  - `e2e-summary.json`
  - `validate-master-summary.json`
- Bundle/manifest:
  - `manifest.json`
  - `approval-bundle/bundle-manifest.json`

Verification commands:

- `npm run validate:release-evidence -- --release-id <release-id> --phase all`
- `npm run check:release-docs`

## RC freeze rule

Freeze the RC only when **all** of the following are true:

1. Preserved-flow matrix rows are green.
2. Contract and security gates are green.
3. Evidence validation and release-doc consistency checks are green.
4. Canonical evidence paths and filenames exist under the release-id directory.

If any one condition fails, RC status remains **NO-GO** and freeze is blocked.


## Browser gate failure remediation

If `npm run test:e2e` fails:

1. Confirm Playwright report validity: JSON must exist and include at least one suite/spec title.
2. Re-run only impacted deterministic flow with `--grep` for local triage.
3. If failure is infra-transient, rerun the scoped transient-infra test group once in CI.
4. Regenerate `e2e-summary.json` and `playwright-report.json` before requesting GO/NO-GO approval.
