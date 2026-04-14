# Release-Ready Checklist

Use this checklist as a strict go/no-go control for production releases.
A release is **ready** only when every check is an objective **PASS** with captured evidence artifacts.
Capture the release package with the standard handoff template at `docs/release-handoff-template.md`.
Use the canonical operator flow at `docs/deployment-quick-reference.md#canonical-operator-flow-exact-command-sequence` for exact preflight/deploy/postdeploy/restore commands and diagnostics triage.
Use `docs/deployment-quick-reference.md#canonical-hard-gate-sequence-validatemaster-exact-execution-order` and `docs/deployment-quick-reference.md#deterministic-post-deploy-validation-sequence` as the canonical command ordering references.
Use `docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local` for browser provisioning, strict/fallback behavior, evidence requirements, and deterministic remediation.
Use the preserved-flow mapping at `docs/release-flow-test-matrix.md` to ensure RC-critical journeys are validated with deterministic targeted tests before freeze.
Treat `npm run test:e2e` as the canonical browser gate with strict CI/operator behavior and explicit local fallback opt-in only.

## Primary operator command (GO/NO-GO)
Run the operator workflow (fails fast, deterministic order):

```bash
export RELEASE_ID=<release-id>
export KLIENT_BASE_URL=https://<env-host>
export KLIENT_OPS_TOKEN_ACTIVE=<ops-token-active>
export KLIENT_OPS_TOKEN_PREVIOUS=<ops-token-previous-while-rotating>
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```

This command runs, in exact order: Flow A (backup -> parity -> hard gate) and deterministic post-deploy checks (health -> ready -> exports queue -> diagnostics).
All evidence is written under `artifacts/release-evidence/<release-id>`.
The default approver review artifact is `artifacts/release-evidence/<release-id>/approval-bundle/` (directory-manifest format) produced automatically by `release:go-no-go`.
The GO/NO-GO evidence package is complete only when both `artifacts/release-evidence/<release-id>/manifest.json` and `artifacts/release-evidence/<release-id>/approval-bundle/bundle-manifest.json` are present.

Required environment variables:
- `RELEASE_ID` (or pass `--release-id`) for artifact scoping.
- `KLIENT_BASE_URL` for post-deploy health/readiness checks.
- `KLIENT_OPS_TOKEN_ACTIVE` for authenticated ops diagnostics endpoints (recommended).
- `KLIENT_OPS_TOKEN_PREVIOUS` during token rotation windows to prevent postdeploy check interruptions while secrets propagate.
- `KLIENT_OPS_TOKEN` as a legacy fallback if rotation-safe vars are unavailable.
- `RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED` for release-time tuning of allowed stalled queue count (default `0`).
- `RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER` for release-time tuning of allowed dead-letter count (default `0`).
- `RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE` for release-time tuning of allowed retryable-failure count (default `0`).
- `RESTORE_BACKUP_PATH` only when running `--phase restore` or `--phase restore-drill`.

Operator notes (authoritative policy location):
- Strict E2E mode + fallback boundaries are defined only in `docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local` (CI + `release:go-no-go` preflight are always strict; fallback is local/manual only with explicit opt-in).
- Required E2E env flags are `RELEASE_E2E_STRICT_MODE`, `RELEASE_E2E_ALLOW_FALLBACK`, `CI`, and `PLAYWRIGHT_JSON_REPORT`/`RELEASE_E2E_PLAYWRIGHT_REPORT`; keep values command-visible in logs for deterministic triage.
- Expected browser provisioning cache path is `PLAYWRIGHT_BROWSERS_PATH` (default Playwright-managed path when unset/`0`); CI should keep this path stable between install and test steps.
- Release-time environment requirements (including runtime-required app vars) are defined only in `docs/deployment-quick-reference.md#required-environment-variables` and `docs/deployment-quick-reference.md#production-runtime-required-app-variables-from-startup-validation`.
- Evidence bundle required artifacts are defined only in `docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts`.

Hard gate only (non-approval diagnostic/manual mode):

```bash
npm run validate:master
```

`validate:master` is fail-fast by design: after syntax checks, `npm run check:conflicts` runs as a blocking guard and must fail on any merge conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) found in tracked text files or release-critical `scripts/*.mjs` files (notably `scripts/e2e-test.mjs`). Do not bypass this failure; remove markers and rerun.

Gate/documentation parity precheck (required before GO/NO-GO execution and mirrored in CI):

```bash
npm run check:release-docs
npm run check:release-gate-commands
```

Canonical release approval hard-gate execution (single strict path for CI + operator preflight):

```bash
RELEASE_APPROVAL_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master
```

Approval policy reminder:
- `RELEASE_APPROVAL_MODE=1` is the release-approval switch. In this mode, `validate:master` forces strict E2E and ignores fallback-enabling inputs.
- Any `executionMode=fallback` evidence is diagnostic-only and is not approvable release evidence.

Canonical strict release-blocking E2E command (CI gate job):

```bash
RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e
```

Evidence validation mode schema markers (must stay contract-identical across docs/scripts/tests):
- `validationMode=local`
- `validationMode=ci`
- `validationMode=unpacked-artifact`

Canonical gate artifact filenames and required evidence bundle contents are maintained in one location:
`docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts`.

Optional explicit locations:

```bash
RELEASE_EVIDENCE_DIR=artifacts/release-evidence/<release-id> npm run validate:master
# or
RELEASE_EVIDENCE_FILE=artifacts/release-evidence/<release-id>/validate-master-summary.json npm run validate:master
```

## Deterministic command flows (operator runbook)

To avoid command drift, do not maintain a second command sequence here.
Use only `docs/deployment-quick-reference.md#canonical-operator-flow-exact-command-sequence` as the source of truth for:
- preflight phase command
- deploy command
- postdeploy phase command
- restore and restore-drill commands

## Federated auth approval gate (production)
- Production GO requires `AUTH_PROVIDER=oidc` or `AUTH_PROVIDER=saml`.
- `AUTH_PROVIDER=local` is a break-glass exception only and requires all of the following evidence before GO:
  - `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true` was set intentionally for the deployment window.
  - Incident/risk approval is recorded in `docs/release-handoff-template.md` (Section 2 auth mode notes + approver sign-off).
  - A rollback/remediation plan and expiry time for removing break-glass are documented.
- Approvers must explicitly verify provider mode and whether any break-glass exception was used.


## Browser gate failure remediation (canonical path)
When `npm run test:e2e` fails, follow only:
`docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local` → **Deterministic remediation path when E2E fails**.

Do not use alternate local/CI remediation sequences in release operations.

## Objective pass/fail criteria

### Six required command gates (ownership + evidence)

These six gate commands are release-required and must remain command-identical across CI, this checklist, and the runbook.

| Gate | Command owner | Required command | Evidence file (canonical path) | CI attribution job id |
|---|---|---|---|---|
| API contract | API Lead | `npm run test:contract` | `artifacts/release-evidence/<release-id>/api-contract-summary.json` | `api_contract` |
| Integration suites | QA Lead | `npm run test:integration` | `artifacts/release-evidence/<release-id>/integration-summary.json` | `full_integration` |
| Migration checks | Data/DB Owner | `npm run check:migrations` | `artifacts/release-evidence/<release-id>/migration-summary.json` | `migration_checks` |
| Smoke | Release Manager | `npm run test:smoke` | `artifacts/release-evidence/<release-id>/smoke-summary.json` | `smoke_runtime_contract` |
| E2E browser checks | QA Lead | `npm run test:e2e` | `artifacts/release-evidence/<release-id>/e2e-summary.json` | `e2e_release_blocking` |
| Security checks | Security Owner | `npm run test:security` | `artifacts/release-evidence/<release-id>/security-summary.json` | `security_checks` |

| Gate | Owner | Evidence command | Evidence artifact target | PASS criteria | Severity if failed | Rollback trigger (SLO/SLA) |
|---|---|---|---|---|---|---|
| API contract | API Lead | `npm run test:contract` | `artifacts/release-evidence/<release-id>/api-contract-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back immediately if post-deploy contract checks fail for any public endpoint for more than **5 minutes** (SLO breach) or if external consumers report incompatible responses in production (**SLA breach**). |
| Integration suites | QA Lead | `npm run test:integration` | `artifacts/release-evidence/<release-id>/integration-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if critical workflow integration failure persists for **10 minutes** after deploy or blocks tenant onboarding/submission completion. |
| Migration checks | Data/DB Owner | `npm run check:migrations` | `artifacts/release-evidence/<release-id>/migration-summary.json` | Exit code `0`; summary has `status=passed` with migration + idempotency checks. | **SEV-1** | Roll back if migration idempotency fails, aggregate counts drift, or any data correctness SLO is violated; database restore required on confirmed corruption (SLA). |
| Smoke | Release Manager | `npm run test:smoke` | `artifacts/release-evidence/<release-id>/smoke-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if smoke journey fails twice consecutively post-deploy or any core user journey remains broken for **10 minutes**. |
| E2E browser checks | QA Lead | `npm run test:e2e` | `artifacts/release-evidence/<release-id>/e2e-summary.json` | Exit code `0`; summary has `status=passed`; `executionMode` present; `details.artifacts.playwrightJsonReport.path` exists; `details.artifacts.playwrightJsonReport.valid=true`; `details.artifacts.playwrightJsonReport.suiteCount>=1`; `details.artifacts.playwrightEvidenceLinkage.reportPath`, `details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath`, and `details.artifacts.playwrightEvidenceLinkage.provisioningVersion` are present; Playwright JSON artifact parses successfully with collected suite/spec titles. | **SEV-1** | Roll back if core sign-in/dashboard journey fails in production or E2E evidence is missing/inconclusive. |
| Security checks | Security Owner | `npm run test:security` | `artifacts/release-evidence/<release-id>/security-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-0/1** | Roll back immediately on auth bypass, PII exposure risk, or crypto regression (SLA/security policy breach). |
| E2E UI contract checks | QA Lead | `npm run test:ui-contract` | `artifacts/release-evidence/<release-id>/validate-master-summary.json` | Exit code `0`; step status for UI contract checks is `passed` in validate-master summary output. | **SEV-1** | Block GO/NO-GO if UI contract assertions fail or evidence is missing. |
| RBAC matrix + operator path checks | QA Lead + Security Owner | `npm run test:integration -- integration-rbac-matrix` | `artifacts/release-evidence/<release-id>/integration-summary.json` | RBAC matrix passes with explicit deny-path coverage for collaborator share boundaries and operator read/write routes (template compare/publish/revert + exports queue retry). | **SEV-1** | Block GO if collaborator or operator permission boundaries drift from policy matrix guards. |
| Auth provider mode verification | Security Owner + Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/startup-failfast.json` + `docs/release-handoff-template.md` | Production uses `AUTH_PROVIDER=oidc` or `AUTH_PROVIDER=saml`, or break-glass (`AUTH_PROVIDER=local` + `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true`) has explicit recorded approval and expiry/removal plan. | **SEV-1** | Block GO if auth mode is unverified, non-federated without approval, or exception evidence is incomplete. |
| Branch parity | Engineering Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/branch-parity.txt` | Exit code `0`; branch is merge-compatible with `main`. | **SEV-2** | No runtime rollback trigger by itself; block release until parity is restored. |
| Backup metadata | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/backup.json` | Exit code `0`; JSON has `ok=true`, `status=succeeded`, non-empty `artifact.path`, `artifact.sizeBytes>0`, `artifact.sqliteQuickCheck=ok`. | **SEV-1** | Roll back and halt further deploys if deploy proceeds without a verified fresh backup artifact and integrity check. |
| Startup fail-fast probe (invalid config) | Release Manager + API Lead | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/startup-failfast.json` and `artifacts/release-evidence/<release-id>/startup-failfast.txt` | Probe report has `ok=true`, `status=succeeded`, and checks `exitCodeNonZero=true`, `startupBlockedLogged=true`, `startupIssuesPresent=true`, `listenPrevented=true` (proves startup blocked before listen). | **SEV-1** | Block release if probe fails or artifact is missing; invalid production config must fail-fast before bind/listen. |
| Runtime-required env presence preflight | Release Manager + Security Owner | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/preflight-env-summary.json` | JSON has `overall.ready=true`; selected `mode.authProvider`, `mode.piiKeyProvider`, and `mode.storageProvider` are recorded; `auth/opsTokens/pii/storage.ready=true`; guidance fields are present for auth mode, ops token rotation vars, PII provider keys, and storage provider keys; no raw secret values are emitted. | **SEV-1** | Block GO if summary is missing or any readiness group is false. |
| Deterministic preflight flow | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/preflight-env-summary.json`, `artifacts/release-evidence/<release-id>/backup.json`, `artifacts/release-evidence/<release-id>/branch-parity.txt`, `artifacts/release-evidence/<release-id>/startup-failfast.json`, `artifacts/release-evidence/<release-id>/validate-master-summary.json`, `artifacts/release-evidence/<release-id>/e2e-summary.json` | Single command exits `0`; includes passing runtime env presence summary, backup metadata, branch parity, startup fail-fast probe evidence, and hard release gate evidence (including E2E gate output). | **SEV-1** | Block release if flow fails at any stage; no deploy until all evidence is regenerated and PASS. |
| Deterministic restore-validation flow (live restore) | Data/DB Owner + SRE | `RESTORE_BACKUP_PATH=data/backup-<timestamp>.db npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"` | `artifacts/release-evidence/<release-id>/restore.json` | Exit code `0`; JSON has `ok=true`, `executionMode=live-restore`, both `source/restoreTarget.sqliteQuickCheck=ok`, `checks.sizeMatch=true`, `checks.sha256Match=true`. | **SEV-1** | Roll back/hold release if live restore validation fails integrity checks. |
| Verify-only restore drill flow (non-live) | Data/DB Owner + SRE | `RESTORE_BACKUP_PATH=data/backup-<timestamp>.db npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"` | `artifacts/release-evidence/<release-id>/restore-drill.json` | Exit code `0`; JSON has `ok=true`, `executionMode=verify-only-drill`, both `source/restoreTarget.sqliteQuickCheck=ok`, `checks.sizeMatch=true`, `checks.sha256Match=true`. | **SEV-2** | Block GO if drill evidence is required by policy and absent/failed; do not treat drill output as proof of live restore execution. |
| Post-deploy health + readiness | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-health.json`, `artifacts/release-evidence/<release-id>/postdeploy-ready.json` | Both return HTTP `200`; `/health` evaluates healthy, `/ready` returns `status=ready` with `ready=true`, and `/ready checks.databaseReady`, `checks.storageReady`, `checks.exportQueueReachable`, `checks.exportQueueNotStalled`, and `checks.startupConfigValid` are all true. | **SEV-1** | Roll back if health/readiness are non-200 for **>5 minutes** or if readiness remains degraded after one remediation attempt. |
| Export queue diagnostics thresholds | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-exports-queue.json`, `artifacts/release-evidence/<release-id>/postdeploy-evaluation-summary.json` | `queue.stalled <= RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED`; `queue.machineState.deadLetter.count` (or `queue.deadLetter`) `<= RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER`; `queue.failedRetryable <= RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE`. | **SEV-1** | Roll back if queue processing is stalled and no successful processing occurs within **10 minutes** or dead-letter/retryable failures exceed threshold without rapid mitigation. |
| Telemetry/runtime diagnostics | Observability Owner | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-telemetry-bundle.json`, `artifacts/release-evidence/<release-id>/postdeploy-evaluation-summary.json` | `/api/ops/diagnostics startup.runtime.ok` is true (and `/ready` remains minimal/public-safe). | **SEV-1** | Roll back if telemetry indicates sustained SLO breach for **>10 minutes** or unresolved critical/high alerts. |
| Post-deploy enforced rule summary | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-evaluation-summary.json` | Summary has `status=passed`; every rule entry has `passed=true`; threshold values match release-time env var settings. | **SEV-1** | NO-GO if summary is missing or has any failed rule. |
| Evidence manifest | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID"` | `artifacts/release-evidence/<release-id>/manifest.json` | Manifest exists and includes release id, per-phase status, generation timestamp, and SHA-256 metadata for produced artifact files. | **SEV-1** | Block GO/NO-GO decision until manifest is generated and attached to release handoff. |
| Evidence approval bundle (default review artifact) | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID"` | `artifacts/release-evidence/<release-id>/approval-bundle/` and `artifacts/release-evidence/<release-id>/approval-bundle/bundle-manifest.json` | Bundle exists, contains all mandatory checklist evidence for executed phases plus `manifest.json`, and `bundle-manifest.json` has SHA-256 metadata for bundled files. | **SEV-1** | Block GO/NO-GO approval until approvers receive a complete bundle path and manifest-backed file inventory. |

## Deterministic post-deploy validation sequence
Execute in this exact order and stop on first failure:

1. `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` (internally executes health)
2. readiness (executed second inside the command)
3. export queue diagnostics (executed third inside the command)
4. telemetry bundle (executed fourth inside the command)

### Operator guidance for deep debugging
- Treat `/ready` as a machine-usable, minimal readiness probe only (`status`, `ready`, `checks.*`).
- Use `/api/ops/diagnostics` with `KLIENT_OPS_TOKEN` for deep internals (query summary, storage internals, startup warnings/issues, queue internals).
- Use `/api/ops/exports/queue` with `KLIENT_OPS_TOKEN` for queue threshold remediation details.

## Release decision rubric
- **GO**: `npm run release:go-no-go -- --release-id "$RELEASE_ID"` passes and every required row above is PASS with captured command output, evidence files, `manifest.json`, and the default approver bundle at `artifacts/release-evidence/<release-id>/approval-bundle/`.
- **NO-GO**: Any row FAILS, is skipped, or has inconclusive evidence.

## Restore evidence decision rules
- Live rollback evidence: `restore.json` and `executionMode=live-restore`.
- Drill evidence only: `restore-drill.json` and `executionMode=verify-only-drill`.
- `manifest.json` records both restore command modes under `phaseStatuses.restore` with terminal `status` (`passed` or `failed`) and whichever restore artifact was produced in that execution.
- A restore-only command completion must not leave any phase in `pending`; restore phase state is terminal when the process exits.
- Never mark a live rollback as complete based on `restore-drill.json`.


## Documentation freshness owner
- **Owner:** Release Operations (Release Manager + SRE primary)
- **Expectation:** keep this checklist synchronized with `docs/deployment-quick-reference.md` whenever runtime validation logic, thresholds, or evidence artifacts change.
