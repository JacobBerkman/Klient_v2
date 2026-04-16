# Release Candidate Routed-Flow Test Matrix

## Purpose
Define the minimum deterministic automation matrix that must pass before freezing a release candidate (RC).

## Canonical browser release gate

The canonical browser gate is `npm run test:e2e`. It executes the routed/static UI contract checks first, then Playwright browser tests against the React shell, and always writes:

- `artifacts/release-evidence/<release-id>/e2e-summary.json`
- `artifacts/release-evidence/<release-id>/playwright-report.json`

Deterministic guarantees in this path:

- fixed host/port from `createTestContext` (`http://127.0.0.1:<deterministic-port>`),
- isolated reset behavior default (`TEST_RESET_BEHAVIOR=isolated`),
- strict CI behavior (local fallback is ignored whenever `CI=true`),
- the React/Vite app is already compiled by the `npm run web:build` hard gate before runtime/browser validation.

For canonical provisioning/fallback/evidence/remediation policy, use:
`docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local`.

## Routed flow to deterministic test mapping

| Routed flow | Deterministic automated test(s) | Why this is the primary gate |
|---|---|---|
| Admin bootstrap (register + login + dashboard landing) | `npx playwright test tests/e2e/smoke.spec.mjs --grep "registers a firm admin and lands on dashboard"` | End-to-end routed UI + API workflow with deterministic seeded IDs validates bootstrap and authentication path in one run. |
| Advisor workflow completion (template detail preview + publish) | `npx playwright test tests/e2e/workflows.spec.mjs --grep "routed template detail supports preview and publish controls"` | Deterministically covers routed template detail/editor behavior without returning to the legacy shell. |
| Portal submit lifecycle (draft -> submitted) | `npx playwright test tests/e2e/workflows.spec.mjs --grep "routed portal token lifecycle saves draft and submits form"` | Explicitly verifies the routed `/portal` submission lifecycle and keeps legacy portal coverage isolated in `tests/e2e/legacy.spec.mjs`. |
| Release smoke journey (health/ready + profile/template/submission/export path) | `npm run test:smoke` | Validates the canonical production smoke path and writes release evidence in the canonical schema. |

## Targeted gap-fill strategy (avoid broad duplicate suites)

1. Run the three flow-specific Playwright tests above individually (`--grep`) instead of full-suite duplicate runs.
2. Keep smoke coverage in `npm run test:smoke` as the cross-module path check.
3. Use `npm run test:integration` once as the aggregated integration gate; do not add a second full integration pass unless a failure requires rerun after a fix.

## Operator runbook notes (template diagnostics)

Use this when triaging template publish readiness evidence during RC validation:

- In the routed template detail page, confirm mappings, version history, preview, and publish controls are visible for the selected template.
- Use **Run preview** before **Publish template** so the release evidence covers the mapped-template preview path.
- Keep any intentional legacy reachability check in `tests/e2e/legacy.spec.mjs`; do not mix `/legacy` into release-blocking product flows.
- Attach the result of the deterministic flow test command below to the release handoff evidence set:
- `npx playwright test tests/e2e/workflows.spec.mjs --grep "routed template detail supports preview and publish controls"`

## Cross-cutting regression gates

Run these after targeted routed-flow checks:

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
- `npm run web:build`
- `npm run check:release-docs`
- `npm run check:release-gate-commands`
- `RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master`
- `RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e`

Evidence validation mode schema markers (must remain stable in validation output contracts):
- `validationMode=local`
- `validationMode=ci`
- `validationMode=unpacked-artifact`

Required E2E artifact schema markers (must remain synchronized with runbook/checklist/handoff docs):
- `executionMode`
- `details.artifacts.playwrightJsonReport.path`
- `details.artifacts.playwrightJsonReport.valid`
- `details.artifacts.playwrightJsonReport.suiteCount`
- `details.artifacts.playwrightEvidenceLinkage.reportPath`
- `details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath`
- `details.artifacts.playwrightEvidenceLinkage.provisioningVersion`

## RC freeze rule

Freeze the RC only when **all** of the following are true:

1. Routed-flow matrix rows are green.
2. Contract and security gates are green.
3. Evidence validation and release-doc consistency checks are green.
4. Canonical evidence paths and filenames exist under the release-id directory.

If any one condition fails, RC status remains **NO-GO** and freeze is blocked.

## Browser gate failure remediation

If `npm run test:e2e` fails, use only:
`docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local` -> **Deterministic remediation path when E2E fails**.
