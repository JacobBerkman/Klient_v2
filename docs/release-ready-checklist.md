# Release-Ready Checklist

Use this checklist as a strict go/no-go control for production releases.
A release is **ready** only when every check is an objective **PASS** with captured evidence artifacts.
Capture the release package with the standard handoff template at `docs/release-handoff-template.md`.
Use the command-level quick runbook at `docs/deployment-quick-reference.md` for exact preflight/deploy/postdeploy/restore sequences and diagnostics triage.

## Primary operator command (GO/NO-GO)
Run the operator workflow (fails fast, deterministic order):

```bash
export RELEASE_ID=<release-id>
export KLIENT_BASE_URL=https://<env-host>
export KLIENT_OPS_TOKEN=<ops-token>
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```

This command runs, in exact order: Flow A (backup -> parity -> hard gate) and deterministic post-deploy checks (health -> ready -> exports queue -> diagnostics).
All evidence is written under `artifacts/release-evidence/<release-id>`.
The GO/NO-GO evidence package is complete only when `artifacts/release-evidence/<release-id>/manifest.json` is present and includes phase statuses plus SHA-256 metadata for produced artifacts.

Required environment variables:
- `RELEASE_ID` (or pass `--release-id`) for artifact scoping.
- `KLIENT_BASE_URL` for post-deploy health/readiness checks.
- `KLIENT_OPS_TOKEN` for authenticated ops diagnostics endpoints.
- `RESTORE_BACKUP_PATH` only when running `--phase restore` or `--phase restore-drill`.

Hard gate only (legacy/manual mode):

```bash
npm run validate:master
```

Master summary artifact:

```text
artifacts/release-evidence/<release-id>/validate-master-summary.json
```

Per-gate summary artifacts (emitted automatically by gate scripts):

```text
artifacts/release-evidence/<release-id>/api-contract-summary.json
artifacts/release-evidence/<release-id>/integration-summary.json
artifacts/release-evidence/<release-id>/migration-summary.json
artifacts/release-evidence/<release-id>/smoke-summary.json
artifacts/release-evidence/<release-id>/security-summary.json
```

Optional explicit locations:

```bash
RELEASE_EVIDENCE_DIR=artifacts/release-evidence/<release-id> npm run validate:master
# or
RELEASE_EVIDENCE_FILE=artifacts/release-evidence/<release-id>/validate-master-summary.json npm run validate:master
```

## Deterministic command flows (operator runbook)

### Flow A — deterministic preflight (single command)
```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight
```

### Flow B — deterministic restore-validation (single command, live rollback path)
```bash
RESTORE_BACKUP_PATH=data/backup-<timestamp>.db \
  npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"
```

### Flow B.1 — verify-only restore drill (single command, non-live path)
```bash
RESTORE_BACKUP_PATH=data/backup-<timestamp>.db \
  npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"
```

## Objective pass/fail criteria

| Gate | Owner | Evidence command | Evidence artifact target | PASS criteria | Severity if failed | Rollback trigger (SLO/SLA) |
|---|---|---|---|---|---|---|
| API contract | API Lead | `npm run test:contract` | `artifacts/release-evidence/<release-id>/api-contract-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back immediately if post-deploy contract checks fail for any public endpoint for more than **5 minutes** (SLO breach) or if external consumers report incompatible responses in production (**SLA breach**). |
| Integration suites | QA Lead | `npm run test:integration` | `artifacts/release-evidence/<release-id>/integration-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if critical workflow integration failure persists for **10 minutes** after deploy or blocks tenant onboarding/submission completion. |
| Migration checks | Data/DB Owner | `npm run check:migrations` | `artifacts/release-evidence/<release-id>/migration-summary.json` | Exit code `0`; summary has `status=passed` with migration + idempotency checks. | **SEV-1** | Roll back if migration idempotency fails, aggregate counts drift, or any data correctness SLO is violated; database restore required on confirmed corruption (SLA). |
| Smoke | Release Manager | `npm run test:smoke` | `artifacts/release-evidence/<release-id>/smoke-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if smoke journey fails twice consecutively post-deploy or any core user journey remains broken for **10 minutes**. |
| Security checks | Security Owner | `npm run test:security` | `artifacts/release-evidence/<release-id>/security-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-0/1** | Roll back immediately on auth bypass, PII exposure risk, or crypto regression (SLA/security policy breach). |
| Branch parity | Engineering Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/branch-parity.txt` | Exit code `0`; branch is merge-compatible with `main`. | **SEV-2** | No runtime rollback trigger by itself; block release until parity is restored. |
| Backup metadata | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/backup.json` | Exit code `0`; JSON has `ok=true`, `status=succeeded`, non-empty `artifact.path`, `artifact.sizeBytes>0`, `artifact.sqliteQuickCheck=ok`. | **SEV-1** | Roll back and halt further deploys if deploy proceeds without a verified fresh backup artifact and integrity check. |
| Startup fail-fast probe (invalid config) | Release Manager + API Lead | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/startup-failfast.json` and `artifacts/release-evidence/<release-id>/startup-failfast.txt` | Probe report has `ok=true`, `status=succeeded`, and checks `exitCodeNonZero=true`, `startupBlockedLogged=true`, `startupIssuesPresent=true`, `listenPrevented=true` (proves startup blocked before listen). | **SEV-1** | Block release if probe fails or artifact is missing; invalid production config must fail-fast before bind/listen. |
| Deterministic preflight flow | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight` | `artifacts/release-evidence/<release-id>/backup.json`, `artifacts/release-evidence/<release-id>/branch-parity.txt`, `artifacts/release-evidence/<release-id>/startup-failfast.json`, `artifacts/release-evidence/<release-id>/validate-master-summary.json` | Single command exits `0`; includes passing backup metadata, branch parity, startup fail-fast probe evidence, and hard release gate evidence. | **SEV-1** | Block release if flow fails at any stage; no deploy until all evidence is regenerated and PASS. |
| Deterministic restore-validation flow (live restore) | Data/DB Owner + SRE | `RESTORE_BACKUP_PATH=data/backup-<timestamp>.db npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"` | `artifacts/release-evidence/<release-id>/restore.json` | Exit code `0`; JSON has `ok=true`, `executionMode=live-restore`, both `source/restoreTarget.sqliteQuickCheck=ok`, `checks.sizeMatch=true`, `checks.sha256Match=true`. | **SEV-1** | Roll back/hold release if live restore validation fails integrity checks. |
| Verify-only restore drill flow (non-live) | Data/DB Owner + SRE | `RESTORE_BACKUP_PATH=data/backup-<timestamp>.db npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"` | `artifacts/release-evidence/<release-id>/restore-drill.json` | Exit code `0`; JSON has `ok=true`, `executionMode=verify-only-drill`, both `source/restoreTarget.sqliteQuickCheck=ok`, `checks.sizeMatch=true`, `checks.sha256Match=true`. | **SEV-2** | Block GO if drill evidence is required by policy and absent/failed; do not treat drill output as proof of live restore execution. |
| Post-deploy health + readiness | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-health.json`, `artifacts/release-evidence/<release-id>/postdeploy-ready.json` | Both return HTTP `200`; readiness has `status=ready` and `checks.*=true`. | **SEV-1** | Roll back if health/readiness are non-200 for **>5 minutes** or if readiness remains degraded after one remediation attempt. |
| Export queue diagnostics | SRE / On-call | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-exports-queue.json` | Endpoint returns HTTP `200` and queue counters are machine-parseable. | **SEV-1** | Roll back if queue processing is stalled and no successful processing occurs within **10 minutes**. |
| Telemetry bundle | Observability Owner | `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` | `artifacts/release-evidence/<release-id>/postdeploy-telemetry-bundle.json` | Endpoint returns HTTP `200`; bundle includes startup/runtime diagnostics and export/audit/security sections. | **SEV-1** | Roll back if telemetry indicates sustained SLO breach for **>10 minutes** or unresolved critical/high alerts. |
| Evidence manifest | Release Manager | `npm run release:go-no-go -- --release-id "$RELEASE_ID"` | `artifacts/release-evidence/<release-id>/manifest.json` | Manifest exists and includes release id, per-phase status, generation timestamp, and SHA-256 metadata for produced artifact files. | **SEV-1** | Block GO/NO-GO decision until manifest is generated and attached to release handoff. |

## Deterministic post-deploy validation sequence
Execute in this exact order and stop on first failure:

1. `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` (internally executes health)
2. readiness (executed second inside the command)
3. export queue diagnostics (executed third inside the command)
4. telemetry bundle (executed fourth inside the command)

## Release decision rubric
- **GO**: `npm run release:go-no-go -- --release-id "$RELEASE_ID"` passes and every required row above is PASS with captured command output, evidence files, and `manifest.json`.
- **NO-GO**: Any row FAILS, is skipped, or has inconclusive evidence.

## Restore evidence interpretation rules
- Use `restore.json` only for real rollback execution evidence and require `executionMode=live-restore`.
- Use `restore-drill.json` only for verify-only drill evidence and require `executionMode=verify-only-drill`.
- Never mark a live rollback as complete based on `restore-drill.json`; drill output is intentionally separated to prevent operator confusion.
