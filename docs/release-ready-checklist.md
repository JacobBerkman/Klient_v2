# Release-Ready Checklist

Use this checklist as a strict go/no-go control for production releases.
A release is **ready** only when every check is an objective **PASS** with captured evidence artifacts.

## Gate command
Run the hard gate:

```bash
npm run validate:master
```

Master summary artifact:

```text
artifacts/release-evidence/validate-master-summary.json
```

Per-gate summary artifacts (emitted automatically by gate scripts):

```text
artifacts/release-evidence/api-contract-summary.json
artifacts/release-evidence/integration-summary.json
artifacts/release-evidence/migration-summary.json
artifacts/release-evidence/smoke-summary.json
artifacts/release-evidence/security-summary.json
```

Optional explicit locations:

```bash
RELEASE_EVIDENCE_DIR=artifacts/release-evidence/<release-id> npm run validate:master
# or
RELEASE_EVIDENCE_FILE=artifacts/release-evidence/<release-id>/validate-master-summary.json npm run validate:master
```

## Objective pass/fail criteria

| Gate | Owner | Evidence command | Evidence artifact target | PASS criteria | Severity if failed | Rollback trigger (SLO/SLA) |
|---|---|---|---|---|---|---|
| API contract | API Lead | `npm run test:contract` | `artifacts/release-evidence/api-contract-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back immediately if post-deploy contract checks fail for any public endpoint for more than **5 minutes** (SLO breach) or if external consumers report incompatible responses in production (**SLA breach**). |
| Integration suites | QA Lead | `npm run test:integration` | `artifacts/release-evidence/integration-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if critical workflow integration failure persists for **10 minutes** after deploy or blocks tenant onboarding/submission completion. |
| Migration checks | Data/DB Owner | `npm run check:migrations` | `artifacts/release-evidence/migration-summary.json` | Exit code `0`; summary has `status=passed` with migration + idempotency checks. | **SEV-1** | Roll back if migration idempotency fails, aggregate counts drift, or any data correctness SLO is violated; database restore required on confirmed corruption (SLA). |
| Smoke | Release Manager | `npm run test:smoke` | `artifacts/release-evidence/smoke-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-1** | Roll back if smoke journey fails twice consecutively post-deploy or any core user journey remains broken for **10 minutes**. |
| Security checks | Security Owner | `npm run test:security` | `artifacts/release-evidence/security-summary.json` | Exit code `0`; summary has `status=passed`. | **SEV-0/1** | Roll back immediately on auth bypass, PII exposure risk, or crypto regression (SLA/security policy breach). |
| Branch parity | Engineering Manager | `npm run check:merge-main \
  | tee artifacts/release-evidence/branch-parity.txt` | `artifacts/release-evidence/branch-parity.txt` | Exit code `0`; branch is merge-compatible with `main`. | **SEV-2** | No runtime rollback trigger by itself; block release until parity is restored. |
| Backup present | SRE / On-call | `npm run backup && ls -l data/backup-*.db | tail -n 1 | tee artifacts/release-evidence/backup-latest.txt` | `artifacts/release-evidence/backup-latest.txt` | New timestamped backup artifact exists in `data/`. | **SEV-1** | Roll back and halt further deploys if deploy proceeds without a verified fresh backup. |
| Post-deploy health + readiness | SRE / On-call | `curl -fsS "$KLIENT_BASE_URL/health" | tee artifacts/release-evidence/postdeploy-health.json && curl -fsS "$KLIENT_BASE_URL/ready" | tee artifacts/release-evidence/postdeploy-ready.json` | `artifacts/release-evidence/postdeploy-health.json`, `artifacts/release-evidence/postdeploy-ready.json` | Both return HTTP `200`; readiness has `status=ready` and `checks.*=true`. | **SEV-1** | Roll back if health/readiness are non-200 for **>5 minutes** or if readiness remains degraded after one remediation attempt. |
| Export queue diagnostics | SRE / On-call | `curl -fsS -H "Authorization: Bearer $KLIENT_OPS_TOKEN" "$KLIENT_BASE_URL/api/ops/exports/queue" | tee artifacts/release-evidence/postdeploy-exports-queue.json` | `artifacts/release-evidence/postdeploy-exports-queue.json` | Endpoint returns HTTP `200` and queue counters are machine-parseable. | **SEV-1** | Roll back if queue processing is stalled and no successful processing occurs within **10 minutes**. |
| Telemetry bundle | Observability Owner | `curl -fsS -H "Authorization: Bearer $KLIENT_OPS_TOKEN" "$KLIENT_BASE_URL/api/ops/diagnostics" | tee artifacts/release-evidence/postdeploy-telemetry-bundle.json` | `artifacts/release-evidence/postdeploy-telemetry-bundle.json` | Endpoint returns HTTP `200`; bundle includes startup/runtime diagnostics and export/audit/security sections. | **SEV-1** | Roll back if telemetry indicates sustained SLO breach for **>10 minutes** or unresolved critical/high alerts. |

## Deterministic post-deploy validation sequence
Execute in this exact order and stop on first failure:

1. `curl -fsS "$KLIENT_BASE_URL/health" | tee artifacts/release-evidence/postdeploy-health.json`
2. `curl -fsS "$KLIENT_BASE_URL/ready" | tee artifacts/release-evidence/postdeploy-ready.json`
3. `curl -fsS -H "Authorization: Bearer $KLIENT_OPS_TOKEN" "$KLIENT_BASE_URL/api/ops/exports/queue" | tee artifacts/release-evidence/postdeploy-exports-queue.json`
4. `curl -fsS -H "Authorization: Bearer $KLIENT_OPS_TOKEN" "$KLIENT_BASE_URL/api/ops/diagnostics" | tee artifacts/release-evidence/postdeploy-telemetry-bundle.json`

## Release decision rubric
- **GO**: Every row above is PASS with captured command output and evidence files.
- **NO-GO**: Any row FAILS, is skipped, or has inconclusive evidence.
