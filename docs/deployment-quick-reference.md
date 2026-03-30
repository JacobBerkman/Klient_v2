# Deployment Quick Reference Runbook

Use this page as the command-level operator runbook for release preflight, deploy, post-deploy validation, and restore drills/recovery.

## Required environment variables
Set these before running flows (never commit secret values):

| Variable | Required for | Purpose |
|---|---|---|
| `RELEASE_ID` | all flows | Scopes artifacts to `artifacts/release-evidence/<release-id>`. |
| `KLIENT_BASE_URL` | postdeploy, full operator run | Base URL for `/health`, `/ready`, and ops diagnostics checks. |
| `KLIENT_OPS_TOKEN` | postdeploy, full operator run | Bearer token for `/api/ops/exports/queue` and `/api/ops/diagnostics`. |
| `RESTORE_BACKUP_PATH` | restore/drill only | Backup file path used for restore validation flow. |

Baseline app/runtime variables remain required per deployment target (`APP_SECRET`, `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `ENABLE_DEMO_MODE`, and KMS keys when enabled).

## Expected artifact outputs and locations
All flow evidence is written under:

```text
artifacts/release-evidence/<release-id>/
```

Core outputs by phase:

| Phase | Expected outputs |
|---|---|
| Preflight | `backup.json`, `branch-parity.txt`, `validate-master-summary.json`, plus gate summaries (`api-contract-summary.json`, `integration-summary.json`, `migration-summary.json`, `smoke-summary.json`, `security-summary.json`). |
| Postdeploy | `postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`. |
| Restore (live rollback) | `restore.json` with `executionMode=live-restore`. |
| Restore drill (verify-only) | `restore-drill.json` with `executionMode=verify-only-drill`. |

## Exact command sequence

### 0) One-time shell setup for the release window
```bash
export RELEASE_ID=<release-id>
export KLIENT_BASE_URL=https://<env-host>
export KLIENT_OPS_TOKEN=<ops-token>
```

### 1) Preflight (must pass before deploy)
```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight
```

### 2) Deploy
```bash
docker compose --env-file .env up --build -d
```

### 3) Postdeploy validation (run in this phase after deploy)
```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy
```

### 4) Restore / rollback drill (or recovery)
```bash
export RESTORE_BACKUP_PATH=data/backup-<timestamp>.db
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"
```

Verify-only drill command:

```bash
export RESTORE_BACKUP_PATH=data/backup-<timestamp>.db
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"
```

Decision rule (must match artifact + mode):
- Live rollback evidence: `restore.json` and `executionMode=live-restore`.
- Drill evidence only: `restore-drill.json` and `executionMode=verify-only-drill`.
- Never mark a live rollback as complete based on `restore-drill.json`.

## Common failure signatures (diagnostics-keyed)

| Signature | Diagnostic field(s) to inspect | Where to inspect | Typical interpretation | Immediate operator action |
|---|---|---|---|---|
| Readiness degraded | `checks.databaseReady`, `checks.storageReady`, `checks.exportQueueReachable`, `checks.startupConfigValid` | `postdeploy-ready.json` (`/ready`) | One or more core dependencies are not ready. | Stop release progression, remediate failed dependency, rerun postdeploy phase. |
| Runtime config invalid at readiness | `startupDiagnostics.ok`, `startupDiagnostics.issues[]`, `startupDiagnostics.warnings[]` | `postdeploy-ready.json` and `postdeploy-telemetry-bundle.json` (`startup.runtime`) | Required runtime config is invalid or risky. | Fix env/config contract, redeploy, rerun preflight + postdeploy evidence. |
| Queue backlog growth / stalled processing | `queue.pending`, `queue.stalled`, `queue.readyNow`, `queue.activeLeasesCount` | `postdeploy-exports-queue.json` (`/api/ops/exports/queue`) | Worker is not draining jobs fast enough or lease contention exists. | Run export worker/process path checks, verify retry behavior, hold GO decision until queue stabilizes. |
| Dead-letter spike | `queue.machineState.deadLetter.count`, `queue.failedRetryable` | `postdeploy-exports-queue.json`; corroborate with telemetry `data.queue` | Permanent or repeated export failures accumulating. | Investigate failure root cause, retry only safe jobs, consider rollback if sustained. |
| Telemetry indicates config/security instability | `startup.runtime.ok`, `data.security.csrf.rejectedTotal`, `data.security.sessions.rejectedTotal` | `postdeploy-telemetry-bundle.json` (`/api/ops/diagnostics`) | Misconfiguration or auth/session regressions after deploy. | Treat as release blocker, remediate and revalidate; rollback if SLA/SLO trigger persists. |

## Optional single-command full operator flow
If running the complete workflow (preflight + postdeploy in deterministic order):

```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```
