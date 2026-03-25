# Release-Ready Checklist

Use this checklist as a strict go/no-go control for production releases.
A release is **ready** only when every check is an objective **PASS**.

## Gate command
Run the hard gate:

```bash
npm run validate:master
```

## Objective pass/fail criteria

| Gate | Owner | Evidence command | PASS criteria | Severity if failed | Rollback trigger (SLO/SLA) |
|---|---|---|---|---|---|
| API contract | API Lead | `npm run test:contract` | Exit code `0`; contract script prints success payload with required API workflow coverage. | **SEV-1** | Roll back immediately if post-deploy contract checks fail for any public endpoint for more than **5 minutes** (SLO breach) or if external consumers report incompatible responses in production (**SLA breach**). |
| Integration suites | QA Lead | `npm run test:integration` | Exit code `0`; all ordered integration scripts pass. | **SEV-1** | Roll back if critical workflow integration failure persists for **10 minutes** after deploy or blocks tenant onboarding/submission completion. |
| Migration checks | Data/DB Owner | `npm run check:migrations` | Exit code `0`; migration order and idempotency checks pass for template aggregate + PII re-encryption path. | **SEV-1** | Roll back if migration idempotency fails, aggregate counts drift, or any data correctness SLO is violated; database restore required on confirmed corruption (SLA). |
| Smoke | Release Manager | `npm run test:smoke` | Exit code `0`; login, profile, template publish, and export flow succeed end-to-end. | **SEV-1** | Roll back if smoke journey fails twice consecutively post-deploy or any core user journey remains broken for **10 minutes**. |
| Security checks | Security Owner | `npm run test:security` | Exit code `0`; auth policy and PII crypto tests pass. | **SEV-0/1** | Roll back immediately on auth bypass, PII exposure risk, or crypto regression (SLA/security policy breach). |
| Claim-status review | Product + Release Manager | `rg -n "(implemented|partial|roadmap)" README.md docs/release-ready-checklist.md apps/web/public/index.html` | Every user-facing marketing/UI claim is tagged (`implemented`/`partial`/`roadmap`) and any non-implemented claim has feature-flag indicator + milestone link. | **SEV-1** | Block production deploy until claim status audit is complete and signed; roll back if a production claim is found materially incorrect post-deploy. |
| Branch parity | Engineering Manager | `npm run check:merge-main` | Exit code `0`; branch is merge-compatible with `main`. | **SEV-2** | No runtime rollback trigger by itself; block release until parity is restored. |
| Backup present | SRE / On-call | `npm run backup` | New timestamped backup artifact exists in `data/`. | **SEV-1** | Roll back and halt further deploys if deploy proceeds without a verified fresh backup. |
| Runtime health after deploy | SRE / On-call | `curl -fsS "$KLIENT_BASE_URL/health" && curl -fsS "$KLIENT_BASE_URL/ready"` | Both endpoints return HTTP `200` and readiness `status=ready`. | **SEV-1** | Roll back if health/readiness are non-200 for **>5 minutes** or if readiness remains degraded after one remediation attempt. |
| Operational telemetry | Observability Owner | `test -n "$KLIENT_TELEMETRY_BUNDLE" && test -f "$KLIENT_TELEMETRY_BUNDLE"` | Logs, metrics, and alerts all meet operational acceptance criteria and no unresolved high-urgency alerts remain. | **SEV-1** | Roll back if telemetry SLOs are violated for **>10 minutes** or if paging alerts stay firing after mitigation attempt. |

## Operational acceptance criteria (logs/metrics/alerts)

Operational readiness requires explicit evidence beyond endpoint health:

- **Logs (structured + complete)**
  - JSON logs are emitted for deployment window with `server.started` and no `runtime.config.invalid` events.
  - Request/error logs include correlation identifiers required for traceability.
  - Error budget for unexpected 5xx-class application errors remains within SLO during validation window.
- **Metrics (fresh + within threshold)**
  - Core SLI metrics are available and current (ingestion lag within agreed window).
  - Error rate, p95 latency, and saturation (CPU/memory/queue depth) remain within release SLO bounds for at least one full validation window.
  - Export worker and readiness/storage diagnostics remain stable with no sustained degradation trend.
- **Alerts (actionable + acknowledged)**
  - No unresolved `critical` or `high` alerts tied to the new revision.
  - Any warning-level alert introduced by the deploy is triaged with owner + ETA.
  - Pager notifications, if triggered, are acknowledged with incident record and resolution state.

## Release decision rubric
- **GO**: Every row above is PASS with captured command output.
- **NO-GO**: Any row FAILS, is skipped, or has inconclusive evidence.

## Signed release evidence template

Use this template for every release and store it with deployment artifacts:

```markdown
# Release Evidence Record

- Release ID:
- Environment:
- Commit SHA:
- Build artifact/tag:
- Release approver (name + role):
- Signature (or signed attestation reference):

## Gate execution evidence

| Gate | Owner | Status (PASS/FAIL) | Severity if failed | Command / Dashboard link | Run ID | Timestamp (UTC) | Evidence link |
|---|---|---|---|---|---|---|---|
| API contract | API Lead |  | SEV-1 | `npm run test:contract` |  |  |  |
| Integration suites | QA Lead |  | SEV-1 | `npm run test:integration` |  |  |  |
| Migration checks | Data/DB Owner |  | SEV-1 | `npm run check:migrations` |  |  |  |
| Smoke | Release Manager |  | SEV-1 | `npm run test:smoke` |  |  |  |
| Security checks | Security Owner |  | SEV-0/1 | `npm run test:security` |  |  |  |
| Claim-status review | Product + Release Manager |  | SEV-1 | `rg -n "(implemented|partial|roadmap)" README.md docs/release-ready-checklist.md apps/web/public/index.html` |  |  |  |
| Branch parity | Engineering Manager |  | SEV-2 | `npm run check:merge-main` |  |  |  |
| Backup present | SRE / On-call |  | SEV-1 | `npm run backup` |  |  |  |
| Runtime health after deploy | SRE / On-call |  | SEV-1 | `curl -fsS "$KLIENT_BASE_URL/health" && curl -fsS "$KLIENT_BASE_URL/ready"` |  |  |  |
| Operational telemetry | Observability Owner |  | SEV-1 | `test -n "$KLIENT_TELEMETRY_BUNDLE" && test -f "$KLIENT_TELEMETRY_BUNDLE"` |  |  |  |

## Deployment timeline

- Deploy start (UTC):
- Deploy end (UTC):
- Validation window start/end (UTC):

## Rollback decision

- Decision: `No rollback` / `Rollback executed`
- Decision timestamp (UTC):
- Decision owner:
- Trigger condition (SLO/SLA reference):
- Backup artifact used (if rollback):
- Previous stable version restored:
- Incident/ticket link:
- Notes:
```
