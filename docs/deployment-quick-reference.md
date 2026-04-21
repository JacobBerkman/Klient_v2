# Deployment Quick Reference Runbook

Use this page as the command-level operator runbook for release preflight, deploy, post-deploy validation, and restore drills/recovery.

## Canonical frontend path

The product UI is the routed React/TypeScript/Vite app under `apps/web/src`. `npm run web:build` compiles it into `apps/web/dist`, and the existing Node backend serves those built assets for product routes. `apps/web/public` is legacy-only and remains available explicitly at `/legacy` and `/legacy/portal` until retirement.

## Required environment variables

Set these before running flows (never commit secret values):

| Variable                                        | Required for                     | Purpose                                                                                                             |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `RELEASE_ID`                                    | all flows                        | Scopes artifacts to `artifacts/release-evidence/<release-id>`.                                                      |
| `KLIENT_BASE_URL`                               | postdeploy, full operator run    | Base URL for `/health`, `/ready`, and ops diagnostics checks.                                                       |
| `KLIENT_OPS_TOKEN_ACTIVE`                       | postdeploy, full operator run    | Active bearer token for `/api/ops/exports/queue` and `/api/ops/diagnostics` (recommended for rotation-safe checks). |
| `KLIENT_OPS_TOKEN_PREVIOUS`                     | optional during rotation windows | Previous bearer token kept temporarily to avoid auth breakage while active token propagates.                        |
| `KLIENT_OPS_TOKEN`                              | optional legacy fallback         | Legacy single-token variable; still accepted for compatibility.                                                     |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_STALLED`          | postdeploy, full operator run    | Max allowed `queue.stalled` count (default `0`).                                                                    |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_DEAD_LETTER`      | postdeploy, full operator run    | Max allowed dead-letter count from `queue.machineState.deadLetter.count`/`queue.deadLetter` (default `0`).          |
| `RELEASE_POSTDEPLOY_MAX_QUEUE_FAILED_RETRYABLE` | postdeploy, full operator run    | Max allowed `queue.failedRetryable` count (default `0`).                                                            |
| `RESTORE_BACKUP_PATH`                           | restore/drill only               | Backup file path used for restore validation flow.                                                                  |

## Production runtime-required app variables (from startup validation)

| Variable                                                                                        | Required when                                                         | Runtime enforcement                                                                                           |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                                                                    | always in production                                                  | must be explicitly set and meet minimum strength requirements.                                                |
| `AUTH_PROVIDER`                                                                                 | always in production                                                  | must be explicitly set; `local` requires `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true` or startup is blocked. |
| `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS`                                                        | only for approved incidents where `AUTH_PROVIDER=local` in production | temporary break-glass override; emits warning and should be removed immediately after mitigation.             |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`                  | `AUTH_PROVIDER=oidc`                                                  | all required; issuer + redirect must be HTTPS; client secret must be >= 16 chars.                             |
| `SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_CERT`                                                  | `AUTH_PROVIDER=saml`                                                  | all required; entry point must be HTTPS; cert must contain `BEGIN CERTIFICATE`.                               |
| `PII_KEY_PROVIDER`                                                                              | always in production                                                  | provider selector (`env` or `kms`).                                                                           |
| `PII_ACTIVE_KEY_ID`, `PII_KEYRING`                                                              | `PII_KEY_PROVIDER=env`                                                | both required; `PII_KEYRING` must be JSON and include `PII_ACTIVE_KEY_ID`.                                    |
| `PII_KMS_KEYRING` + (`PII_KMS_ACTIVE_KEY_ID` or `PII_ACTIVE_KEY_ID`)                            | `PII_KEY_PROVIDER=kms`                                                | keyring required and must be JSON; active key id required.                                                    |
| `KLIENT_OPS_TOKEN_ACTIVE`, `KLIENT_OPS_TOKEN_PREVIOUS`, `KLIENT_OPS_TOKENS`, `KLIENT_OPS_TOKEN` | always in production (at least one token required)                    | rotation-safe token set; startup fails if none are set; each provided token must be at least 24 characters.   |
| `STORAGE_PROVIDER`                                                                              | always in production                                                  | storage provider selector (`local` or `s3`).                                                                  |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`      | `STORAGE_PROVIDER=s3`                                                 | required together when S3 storage is selected.                                                                |

## Deployment contract consistency

`docker-compose.yml` environment variables must be a **superset** of runtime production validation requirements so container startup cannot omit a runtime-required key path.

## Expected artifact outputs and locations

All flow evidence is written under:

```text
artifacts/release-evidence/<release-id>/
```

Core outputs by phase:

| Phase                       | Expected outputs                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preflight                   | `preflight-env-summary.json`, `backup.json`, `branch-parity.txt`, `validate-master-summary.json`, `playwright-provisioning.txt`, plus gate summaries (`api-contract-summary.json`, `integration-summary.json`, `migration-summary.json`, `smoke-summary.json`, `security-summary.json`, `e2e-summary.json`). |
| Postdeploy                  | `postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`, `postdeploy-evaluation-summary.json`.                                                                                                                                                |
| Restore (live rollback)     | `restore.json` with `executionMode=live-restore`.                                                                                                                                                                                                                                                            |
| Restore drill (verify-only) | `restore-drill.json` with `executionMode=verify-only-drill`.                                                                                                                                                                                                                                                 |

## Canonical release evidence bundle (required artifacts)

Use this section as the single source of truth for required evidence bundle contents referenced by README/checklist/handoff.

Required gate summaries:

- `preflight-env-summary.json`
- `validate-master-summary.json`
- `api-contract-summary.json`
- `integration-summary.json`
- `migration-summary.json`
- `release-flow-summary.json`
- `smoke-summary.json`
- `security-summary.json`
- `e2e-summary.json`

Canonical release-flow summary path:

- `artifacts/release-evidence/<release-id>/release-flow-summary.json`

E2E hard requirement:

- `e2e-summary.json` must include `executionMode` plus `details.artifacts.playwrightJsonReport.path`, `details.artifacts.playwrightJsonReport.valid=true`, and `details.artifacts.playwrightJsonReport.suiteCount>=1`.
- `e2e-summary.json` must also include `details.artifacts.playwrightEvidenceLinkage` with canonical evidence-dir-relative paths: `reportPath` and (strict browser mode) `provisioningArtifactPath`.
- Optional absolute mirrors may be included as `reportPathAbsolute` and `provisioningArtifactPathAbsolute`, but they must resolve to the same files as the canonical relative fields.
- `provisioningVersion` must be present when strict browser mode provisioning runs.
- The Playwright JSON report referenced by `details.artifacts.playwrightJsonReport.path` must exist, parse as valid JSON, and contain at least one collected suite/spec title; otherwise the E2E gate is failed and GO/NO-GO preflight must stop.
- In strict browser validation modes (`validationMode=ci|unpacked-artifact` or strict release refs), the provisioning artifact referenced by canonical `details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath` must exist.

Required manifest + approval artifacts:

- `manifest.json`
- `approval-bundle/`
- `approval-bundle/bundle-manifest.json`

## Canonical browser-gate policy (CI + local)

Use one policy everywhere for the `test:e2e` browser gate.

### Provisioning

- Always provision Chromium with `npx playwright install --with-deps chromium` before release-blocking E2E runs (CI and operator preflight).
- `release:go-no-go --phase preflight` performs this provisioning step before `validate:master`.
- Expected provisioning artifact: `artifacts/release-evidence/<release-id>/playwright-provisioning.txt`.
- Expected browser cache location is controlled by `PLAYWRIGHT_BROWSERS_PATH` (default `0`, which means Playwright-managed cache under the executing user profile). Keep this path stable across CI jobs so `chromium.executablePath()` resolves deterministically.

### Strictness + fallback behavior

- CI is strict by policy: `RELEASE_E2E_STRICT_MODE=1` and `RELEASE_E2E_ALLOW_FALLBACK=0`.
- Operator preflight hard gate is strict by policy: `release:go-no-go` forces the same strict settings when running `validate:master`.
- Local/manual runs are strict by default unless an operator explicitly opts into local fallback with `RELEASE_E2E_ALLOW_FALLBACK=1` (never allowed in CI).
- Deterministic environment flags for `scripts/e2e-test.mjs`:
  - `RELEASE_E2E_STRICT_MODE`: optional explicit override (`1|true|yes|on` or `0|false|no|off`).
  - `RELEASE_E2E_ALLOW_FALLBACK`: local/manual opt-in only; ignored when strict mode is active.
  - `CI`: any truthy CI signal defaults strict mode to enabled when `RELEASE_E2E_STRICT_MODE` is unset.
  - `PLAYWRIGHT_JSON_REPORT` / `RELEASE_E2E_PLAYWRIGHT_REPORT`: explicit JSON output path consumed by evidence validation.

### Evidence requirements (always required)

- `e2e-summary.json` must have `status=passed`, an `executionMode`, and `details.artifacts.playwrightJsonReport.{path,valid,suiteCount}`.
- `e2e-summary.json` must include `details.artifacts.playwrightEvidenceLinkage.reportPath`, `details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath`, and `details.artifacts.playwrightEvidenceLinkage.provisioningVersion`.
- The Playwright JSON report file must exist at `path`, parse as JSON, and contain at least one suite/spec title.
- Strict `browser` mode evidence must include an existing `playwright-provisioning.txt` file linked from `details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath`.
- Missing/invalid report evidence is a hard NO-GO; regenerate evidence before approval.

### Deterministic remediation path when E2E fails

1. Re-provision browser binaries:
   - `npx playwright install --with-deps chromium`
   - If CI caches browsers, verify `PLAYWRIGHT_BROWSERS_PATH` points to a writable cache path and retry provisioning in that same path.
   - Verify `artifacts/release-evidence/<release-id>/playwright-provisioning.txt` is created and non-empty.
2. Re-run the canonical browser gate command:
   - run the `test:e2e` npm script.
3. If still failing, run only the failing deterministic flow:
   - `npx playwright test tests/e2e/workflows.spec.mjs --grep "<failing-flow-name>"`
4. If binaries are still missing locally, explicitly enable one-time local fallback to unblock triage only:
   - `RELEASE_E2E_ALLOW_FALLBACK=1 RELEASE_E2E_STRICT_MODE=0 npm run test:e2e`
   - Do **not** use this mode in CI or release preflight hard gates.
5. Re-run the `test:e2e` npm script in strict mode to regenerate canonical evidence artifacts.
6. Confirm `e2e-summary.json` contains `details.artifacts.playwrightEvidenceLinkage` with a valid provisioning artifact path/version context and report path.
7. Continue GO/NO-GO only after regenerated `e2e-summary.json` + Playwright JSON report + provisioning artifact all satisfy evidence rules.

## Admin shell operations panel quick links

The admin shell includes an **Operations / Launch readiness** panel that mirrors this runbook and is intended as a fast triage surface.

- `/health`: direct process/dependency health signal used in GO/NO-GO.
- `/ready`: readiness contract including `checks.*` dependency booleans.
- `/api/ops/diagnostics`: startup/runtime diagnostics bundle for configuration/security triage.
- `/api/ops/exports/queue`: export queue saturation/stall/dead-letter diagnostics.
- Release evidence convention: keep all release artifacts under `artifacts/release-evidence/<release-id>/` and refresh postdeploy evidence in place during hypercare checkpoints.

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

### 1) Gate/documentation parity precheck (must pass before preflight)

```bash
npm run check:release-docs
npm run check:release-gate-commands
```

### 1a) Canonical release approval hard-gate invocation (single strict path; must match CI)

```bash
RELEASE_APPROVAL_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master
```

### 1b) Canonical strict release-blocking E2E invocation (CI gate job contract)

```bash
RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e
```

Evidence validation mode schema markers (used by `scripts/validate-release-evidence.mjs`):

- `validationMode=local`
- `validationMode=ci`
- `validationMode=unpacked-artifact`

Approval policy reminder:

- `RELEASE_APPROVAL_MODE=1` activates release approval behavior in `validate:master`, which forces strict E2E (`RELEASE_E2E_STRICT_MODE=1`) and disables fallback (`RELEASE_E2E_ALLOW_FALLBACK=0`) even if conflicting values are provided.
- Any fallback run is diagnostic-only (non-approving).

### 2) Preflight (must pass before deploy)

```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight
```

Behavior notes for this command:

- Runs a runtime-required env preflight using production rules shared with API startup validation (`apps/api/src/runtime-requirements.mjs`).
- Writes `artifacts/release-evidence/<release-id>/preflight-env-summary.json`.
- Artifact intentionally includes only state booleans/mode + missing variable names (no secret values).
- Fails the preflight phase when required env keys are missing for the selected auth/PII/storage modes or when no ops token variable is present.

### 3) Deploy

```bash
docker compose --env-file .env up --build -d
```

The Docker build installs `apps/web` dependencies, runs `npm --prefix apps/web run build`, and copies the generated `apps/web/dist` output into the runtime image.

### 4) Postdeploy validation (run in this phase after deploy)

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

Postdeploy checkpoint retention (every postdeploy execution):

- Latest canonical files remain at the root (`postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`, `postdeploy-evaluation-summary.json`) for backward compatibility.
- Timestamped snapshots are also written under `checkpoints/<timestamp>/` so every checkpoint run is preserved.
- `postdeploy-checkpoints.json` tracks chronological checkpoint timestamps and per-artifact paths.
- `manifest.json` includes `postdeployCheckpoints` with `latestCheckpoint`, `latestArtifacts`, and full `history` so approvers can review both current and prior checkpoint evidence without path guessing.

### 5) Restore / rollback drill (or recovery)

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

| Signature                                       | Diagnostic field(s) to inspect                                                                                                                               | Where to inspect                                                         | Typical interpretation                                                               | Immediate operator action                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Readiness degraded                              | `status`, `ready`, `checks.databaseReady`, `checks.storageReady`, `checks.exportQueueReachable`, `checks.exportQueueNotStalled`, `checks.startupConfigValid` | `postdeploy-ready.json` (`/ready`)                                       | One or more core dependencies are not ready (including stalled export queue leases). | Stop release progression, remediate failed dependency, rerun postdeploy phase.                         |
| Runtime config invalid                          | `startup.runtime.ok`, `startup.runtime.issues[]`, `startup.runtime.warnings[]`                                                                               | `postdeploy-telemetry-bundle.json` (`/api/ops/diagnostics`)              | Required runtime config is invalid or risky.                                         | Fix env/config contract, redeploy, rerun preflight + postdeploy evidence.                              |
| Queue backlog growth / stalled processing       | `queue.pending`, `queue.stalled`, `queue.readyNow`, `queue.activeLeasesCount`                                                                                | `postdeploy-exports-queue.json` (`/api/ops/exports/queue`)               | Worker is not draining jobs fast enough or lease contention exists.                  | Run export worker/process path checks, verify retry behavior, hold GO decision until queue stabilizes. |
| Dead-letter spike                               | `queue.machineState.deadLetter.count`, `queue.failedRetryable`                                                                                               | `postdeploy-exports-queue.json`; corroborate with telemetry `data.queue` | Permanent or repeated export failures accumulating.                                  | Investigate failure root cause, retry only safe jobs, consider rollback if sustained.                  |
| Telemetry indicates config/security instability | `startup.runtime.ok`, `data.security.csrf.rejectedTotal`, `data.security.sessions.rejectedTotal`                                                             | `postdeploy-telemetry-bundle.json` (`/api/ops/diagnostics`)              | Misconfiguration or auth/session regressions after deploy.                           | Treat as release blocker, remediate and revalidate; rollback if SLA/SLO trigger persists.              |

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
- When citing checkpoint history, source timestamps and file paths from `postdeploy-checkpoints.json` (or `manifest.json -> postdeployCheckpoints.history`) and include UTC timestamps explicitly in handoff notes.

## Optional single-command full operator flow

If running the complete workflow (preflight + postdeploy in deterministic order):

```bash
npm run release:go-no-go -- --release-id "$RELEASE_ID"
```

## Canonical hard gate sequence (validate:master exact execution order)

When running `npm run validate:master`, the hard gate executes these commands in this exact order:

1. `npm run check:syntax`
2. `npm run check:conflicts`
3. `npm run web:build`
4. `npm run test:contract`
5. `node scripts/integration-rbac.mjs`
6. `node scripts/integration-tenancy.mjs`
7. `npm run test:integration`
8. `npm run check:migrations`
9. `npm run test:smoke`
10. `npm run test:ui-contract`
11. `npm run test:e2e`
12. `npm run test:security`

Release-blocking expectation:

- Step 2 (`npm run check:conflicts`) is intentionally a hard fail guard. Any merge conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) found in tracked text files **or release-critical scripts under `scripts/*.mjs` (including `scripts/e2e-test.mjs`)** must terminate `validate:master` with a non-zero exit code.
- Operators should treat this as a deterministic preflight block-by-design and must resolve markers before rerunning.

Conditional final step:

- `npm run check:merge-main` runs after step 12 only when the workspace has git metadata and a local `main` branch (or when `VALIDATE_MASTER_FORCE_MERGE_PARITY=1`).

## Release gate command ownership (six required commands)

These six commands are the canonical release evidence gate checks. CI also runs the separate `web_build` job with `npm run web:build` so React compilation/build failures are attributable before runtime/browser validation.

| Gate               | CI job id                | Command owner   | Required command                                          | Evidence file (canonical path)                                      | CI job log artifact prefix         |
| ------------------ | ------------------------ | --------------- | --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| API contract       | `api_contract`           | API Lead        | `npm run test:contract`                                   | `artifacts/release-evidence/<release-id>/api-contract-summary.json` | `artifacts/api-contract-gate/`     |
| Integration suites | `full_integration`       | QA Lead         | `npm run test:integration`                                | `artifacts/release-evidence/<release-id>/integration-summary.json`  | `artifacts/integration-gate/`      |
| Migration checks   | `migration_checks`       | Data/DB Owner   | `npm run check:migrations`                                | `artifacts/release-evidence/<release-id>/migration-summary.json`    | `artifacts/migration-checks-gate/` |
| Smoke              | `smoke_runtime_contract` | Release Manager | `npm run test:smoke`                                      | `artifacts/release-evidence/<release-id>/smoke-summary.json`        | `artifacts/smoke-gate/`            |
| E2E browser checks | `e2e_release_blocking`   | QA Lead         | `npm run test:e2e` (`E2E_GREP='@release-blocking'` in CI) | `artifacts/release-evidence/<release-id>/e2e-summary.json`          | `artifacts/e2e-release-blocking/`  |
| Security checks    | `security_checks`        | Security Owner  | `npm run test:security`                                   | `artifacts/release-evidence/<release-id>/security-summary.json`     | `artifacts/security-gate/`         |

Drift-prevention rule:

- `npm run check:release-gate-commands` validates that these six commands exist in `package.json`, are wired in `.github/workflows/smoke.yml`, and are referenced consistently in this runbook and `docs/release-ready-checklist.md`.
- The smoke gate must cover the real PDF template-to-export path: AcroForm upload/auto-build, linked generated form submission, PDF and XLSX export processing, persisted artifact metadata, and download responses.

## Documentation freshness owner

- **Owner:** Release Operations (Release Manager + SRE primary)
- **Expectation:** when runtime validation commands, phases, thresholds, or evidence schema change, update this runbook, `docs/release-ready-checklist.md`, `docs/release-handoff-template.md`, and README release-operation links in the same pull request.
