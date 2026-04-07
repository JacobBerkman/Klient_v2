# Deployment Quick Reference Runbook

Use this page as the command-level operator runbook for release preflight, deploy, post-deploy validation, and restore drills/recovery.

## Required environment variables
Set these before running flows (never commit secret values):

| Variable | Required for | Purpose |
|---|---|---|
| `RELEASE_ID` | all flows | Scopes artifacts to `artifacts/release-evidence/<release-id>`. |
| `KLIENT_BASE_URL` | postdeploy, full operator run | Base URL for `/health`, `/ready`, and ops diagnostics checks. |
| `KLIENT_OPS_TOKEN_ACTIVE` | postdeploy, full operator run | Active bearer token for `/api/ops/exports/queue` and `/api/ops/diagnostics` (recommended for rotation-safe checks). |
| `KLIENT_OPS_TOKEN_PREVIOUS` | optional during rotation windows | Previous bearer token kept temporarily to avoid auth breakage while active token propagates. |
| `KLIENT_OPS_TOKEN` | optional legacy fallback | Legacy single-token variable; still accepted for compatibility. |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED` | postdeploy, full operator run | Max allowed `queue.stalled` count (default `0`). |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER` | postdeploy, full operator run | Max allowed dead-letter count from `queue.machineState.deadLetter.count`/`queue.deadLetter` (default `0`). |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE` | postdeploy, full operator run | Max allowed `queue.failedRetryable` count (default `0`). |
| `RESTORE_BACKUP_PATH` | restore/drill only | Backup file path used for restore validation flow. |

## Production runtime-required app variables (from startup validation)

| Variable | Required when | Runtime enforcement |
|---|---|---|
| `APP_SECRET` | always in production | must be explicitly set and meet minimum strength requirements. |
| `AUTH_PROVIDER` | always in production | must be explicitly set; `local` requires `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true` or startup is blocked. |
| `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS` | only for approved incidents where `AUTH_PROVIDER=local` in production | temporary break-glass override; emits warning and should be removed immediately after mitigation. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | `AUTH_PROVIDER=oidc` | all required; issuer + redirect must be HTTPS; client secret must be >= 16 chars. |
| `SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_CERT` | `AUTH_PROVIDER=saml` | all required; entry point must be HTTPS; cert must contain `BEGIN CERTIFICATE`. |
| `PII_KEY_PROVIDER` | always in production | provider selector (`env` or `kms`). |
| `PII_ACTIVE_KEY_ID`, `PII_KEYRING` | `PII_KEY_PROVIDER=env` | both required; `PII_KEYRING` must be JSON and include `PII_ACTIVE_KEY_ID`. |
| `PII_KMS_KEYRING` + (`PII_KMS_ACTIVE_KEY_ID` or `PII_ACTIVE_KEY_ID`) | `PII_KEY_PROVIDER=kms` | keyring required and must be JSON; active key id required. |
| `KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, `KLIENT_OPS_TOKEN` | always in production (at least one token required) | rotation-safe token set; startup fails if none are set; each provided token must be at least 24 characters. |
| `STORAGE_PROVIDER` | always in production | storage provider selector (`local` or `s3`). |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | `STORAGE_PROVIDER=s3` | required together when S3 storage is selected. |

## Deployment contract consistency
`docker-compose.yml` environment variables must be a **superset** of runtime production validation requirements so container startup cannot omit a runtime-required key path.

## Expected artifact outputs and locations
All flow evidence is written under:

```text
artifacts/release-evidence/<release-id>/
```

Core outputs by phase:

| Phase | Expected outputs |
|---|---|
| Preflight | `backup.json`, `branch-parity.txt`, `validate-master-summary.json`, plus gate summaries (`api-contract-summary.json`, `integration-summary.json`, `migration-summary.json`, `smoke-summary.json`, `security-summary.json`). |
| Postdeploy | `postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`, `postdeploy-evaluation-summary.json`. |
| Restore (live rollback) | `restore.json` with `executionMode=live-restore`. |
| Restore drill (verify-only) | `restore-drill.json` with `executionMode=verify-only-drill`. |

Manifest semantics for phase-only runs:
- `--phase restore` and `--phase restore-drill` both report under `phaseStatuses.restore`.
- `phaseStatuses.restore.status` is always terminal (`passed` or `failed`) when the command exits; it is never left as `pending`.
- `phaseStatuses.restore.artifacts` contains whichever restore evidence file was produced by that run (`restore.json` for live restore, `restore-drill.json` for verify-only drill).

## Canonical operator flow (exact command sequence)

### 0) One-time shell setup for the release window
```bash
export RELEASE_ID=<release-id>
export KLIENT_BASE_URL=https://<env-host>
export KLIENT_OPS_TOKEN_ACTIVE=<ops-token-active>
export KLIENT_OPS_TOKEN_PREVIOUS=<ops-token-previous-while-rotating>
export RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED=0
export RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER=0
export RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE=0
```

Rotation-safe note:
- Keep both `KLIENT_OPS_TOKEN_ACTIVE` and `KLIENT_OPS_TOKEN_PREVIOUS` set during deploy cutover.
- After postdeploy checks pass with the new active token, remove `KLIENT_OPS_TOKEN_PREVIOUS` per your secret-removal SLA.

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

`--phase postdeploy` now enforces hard GO rules and exits non-zero if any rule fails:
- `/health` and `/ready` must both evaluate healthy/ready.
- `/ready checks.*` must all be `true`.
- `queue.stalled <= RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED`.
- `queue.machineState.deadLetter.count` (or `queue.deadLetter`) `<= RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER`.
- `queue.failedRetryable <= RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE`.
- `/api/ops/diagnostics startup.runtime.ok` must be `true`.

Machine-readable evaluation output:

```text
artifacts/release-evidence/<release-id>/postdeploy-evaluation-summary.json
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
- In `manifest.json`, both commands update `phaseStatuses.restore` status to `passed|failed` and list the generated restore artifact path for that run.
- Never mark a live rollback as complete based on `restore-drill.json`.

## Common failure signatures (diagnostics-keyed)

| Signature | Diagnostic field(s) to inspect | Where to inspect | Typical interpretation | Immediate operator action |
|---|---|---|---|---|
| Readiness degraded | `status`, `ready`, `checks.databaseReady`, `checks.storageReady`, `checks.exportQueueReachable`, `checks.startupConfigValid` | `postdeploy-ready.json` (`/ready`) | One or more core dependencies are not ready. | Stop release progression, remediate failed dependency, rerun postdeploy phase. |
| Runtime config invalid | `startup.runtime.ok`, `startup.runtime.issues[]`, `startup.runtime.warnings[]` | `postdeploy-telemetry-bundle.json` (`/api/ops/diagnostics`) | Required runtime config is invalid or risky. | Fix env/config contract, redeploy, rerun preflight + postdeploy evidence. |
| Queue backlog growth / stalled processing | `queue.pending`, `queue.stalled`, `queue.readyNow`, `queue.activeLeasesCount` | `postdeploy-exports-queue.json` (`/api/ops/exports/queue`) | Worker is not draining jobs fast enough or lease contention exists. | Run export worker/process path checks, verify retry behavior, hold GO decision until queue stabilizes. |
| Dead-letter spike | `queue.machineState.deadLetter.count`, `queue.failedRetryable` | `postdeploy-exports-queue.json`; corroborate with telemetry `data.queue` | Permanent or repeated export failures accumulating. | Investigate failure root cause, retry only safe jobs, consider rollback if sustained. |
| Telemetry indicates config/security instability | `startup.runtime.ok`, `data.security.csrf.rejectedTotal`, `data.security.sessions.rejectedTotal` | `postdeploy-telemetry-bundle.json` (`/api/ops/diagnostics`) | Misconfiguration or auth/session regressions after deploy. | Treat as release blocker, remediate and revalidate; rollback if SLA/SLO trigger persists. |


## First 24 hours (hypercare)

Use this cadence immediately after production deploy to convert post-deploy checks into sustained release confidence.

### Alert cadence
- **0-60 minutes:** monitor `/health`, `/ready`, queue diagnostics, and runtime diagnostics every **5 minutes**.
- **60 minutes to 4 hours:** monitor every **15 minutes** if all checks remain green.
- **4-24 hours:** monitor every **60 minutes** plus normal alert routing.
- Re-run `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy` at each cadence checkpoint and archive refreshed artifacts under the same release evidence directory.

### Escalation path
1. **On-call SRE** triages alert and confirms artifact evidence state.
2. **Release Manager** decides hold/continue status for rollout communications.
3. **Service Owner (API/Platform)** joins for remediation if issue persists beyond one checkpoint.
4. **Security Owner** is paged immediately for auth/session/PII regressions.
5. **Engineering Manager** is paged when rollback criteria are met or customer/SLA impact is confirmed.

### Rollback trigger interpretation
- Treat any `postdeploy-evaluation-summary.json` rule failure as immediate **NO-GO** for progression.
- Roll back when health/readiness remains degraded for more than **5 minutes** after one remediation attempt.
- Roll back when queue processing is stalled for more than **10 minutes** or dead-letter/retryable counts exceed thresholds without clear downward trend.
- Roll back immediately for confirmed security regressions (auth bypass, PII exposure risk, cryptographic control failure).

### Evidence refresh intervals
- Refresh `postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`, and `postdeploy-evaluation-summary.json` at every hypercare checkpoint.
- Update `docs/release-handoff-template.md` decision notes with checkpoint timestamps and any mitigations applied.
- Keep one chronological incident/evidence log per release ID so approvers can audit all post-deploy state transitions.

## Optional single-command full operator flow
If running the complete workflow (preflight + postdeploy in deterministic order):

```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```


## Documentation freshness owner
- **Owner:** Release Operations (Release Manager + SRE primary)
- **Expectation:** when runtime validation commands, phases, thresholds, or evidence schema change, update this runbook, `docs/release-ready-checklist.md`, `docs/release-handoff-template.md`, and README release-operation links in the same pull request.
