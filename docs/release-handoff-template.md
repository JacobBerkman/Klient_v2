# Release Handoff — `<release-id>`

Use this handoff package for every production release so engineering, SRE, and approvers review one consistent record.
For exact operator commands and diagnostics triage, use the canonical operator flow in `docs/deployment-quick-reference.md#canonical-operator-flow-exact-command-sequence`.
For canonical ordering references, use `docs/deployment-quick-reference.md#canonical-hard-gate-sequence-validatemaster-exact-execution-order` and `docs/deployment-quick-reference.md#deterministic-post-deploy-validation-sequence`.
For a filled historical example, see `docs/release-handoffs/release-handoff-2026-03-30.md`.

Architecture note: this release process assumes the existing single-process **Node + SQLite + static web** deployment model (no split app-tier/database migration in this template).

## 1) Release identity
- **Release ID**: `<release-id>`
- **Environment**: `<staging|production>`
- **Release manager**: `<name>`
- **Deployment window (UTC)**: `<YYYY-MM-DD HH:MM-HH:MM UTC>`
- **Commit / tag**: `<git-sha>` / `<tag-or-none>`
- **Container image**: `<registry/image:tag>`
- **Image digest**: `sha256:<digest>`

Release identity collection checklist (fill before GO/NO-GO):
- `Release ID`: match the `RELEASE_ID` environment variable used for artifact generation.
- `Environment`: must be an explicit deploy target (`staging` or `production`).
- `Commit / tag`: record the immutable git commit SHA (or signed tag that resolves to a commit).
- `Image digest`: record the immutable OCI digest actually deployed (`sha256:...`), not a mutable image tag.

## 2) Required environment keys (presence check)
Record whether each required key is set in the deployment target (do not paste secret values).
Use `docs/deployment-quick-reference.md#required-environment-variables` and
`docs/deployment-quick-reference.md#production-runtime-required-app-variables-from-startup-validation`
as the single-source definitions for release-time env requirements.
Do not add secret values in this handoff; record presence and secret/version references only.

| Key | Present (Y/N) | Notes |
|---|---|---|
| `APP_SECRET` | `<Y/N>` | `<how validated>` |
| `AUTH_PROVIDER` | `<Y/N>` | `<oidc|saml|local>` |
| `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS` (only if `AUTH_PROVIDER=local`) | `<Y/N/N/A>` | `<approval + expiry details>` |
| `NODE_ENV` | `<Y/N>` | `<expected value>` |
| `PORT` | `<Y/N>` | `<expected value>` |
| `HOST` | `<Y/N>` | `<expected value>` |
| `LOG_LEVEL` | `<Y/N>` | `<expected value>` |
| `ENABLE_DEMO_MODE` | `<Y/N>` | `<expected value>` |
| `KLIENT_BASE_URL` | `<Y/N>` | `<public url validated>` |
| `KLIENT_OPS_TOKEN_ACTIVE` | `<Y/N>` | `<active token secret/version reference>` |
| `KLIENT_OPS_TOKEN_PREVIOUS` | `<Y/N/N/A>` | `<overlap window + planned removal timestamp>` |
| `KLIENT_OPS_TOKEN` (legacy fallback) | `<Y/N/N/A>` | `<only when rotation-safe vars are unavailable>` |
| `PII_KEY_PROVIDER` | `<Y/N>` | `<env|kms>` |
| `PII_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=env`) | `<Y/N/N/A>` | `<details>` |
| `PII_KEYRING` (if `PII_KEY_PROVIDER=env`) | `<Y/N/N/A>` | `<details>` |
| `PII_KMS_KEY_ALIAS` (if `PII_KEY_PROVIDER=kms`) | `<Y/N/N/A>` | `<details>` |
| `PII_KMS_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=kms`) | `<Y/N/N/A>` | `<details>` |
| `PII_KMS_KEYRING` (if `PII_KEY_PROVIDER=kms`) | `<Y/N/N/A>` | `<details>` |

## 2a) Auth provider verification and exceptions (required for approvers)
Record explicit auth mode verification for production GO.

| Check | Result | Evidence path / notes |
|---|---|---|
| Production provider mode is federated (`oidc` or `saml`) | `<PASS/FAIL>` | `<value + evidence source>` |
| If `AUTH_PROVIDER=local`, break-glass was explicitly approved | `<PASS/FAIL/N/A>` | `<ticket/incident + approvers>` |
| If break-glass used, `ALLOW_PRODUCTION_LOCAL_AUTH_BREAKGLASS=true` confirmed and expiry/removal plan recorded | `<PASS/FAIL/N/A>` | `<planned removal date/time>` |

## 2b) Startup fail-fast verification (production)
Confirm that startup fails before bind/listen when runtime config is invalid, and records clear issues.
Use `artifacts/release-evidence/<release-id>/startup-failfast.json` as the default evidence source from `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight`.

| Check | Result | Evidence path / notes |
|---|---|---|
| Invalid production config blocks startup (`server.startup.blocked`) | `<PASS/FAIL>` | `<path + field>` |
| Error payload lists startup validation issues | `<PASS/FAIL>` | `<path + field>` |
| Startup is blocked before bind/listen | `<PASS/FAIL>` | `<path + field>` |

## 2c) Ops token rotation handoff checklist (deployment window)
Record rotation details so postdeploy checks can run while active/previous token overlap is in place.

| Check | Result | Evidence path / notes |
|---|---|---|
| Rotation timestamp (UTC) captured | PASS/FAIL | Include exact cutover time (e.g., `2026-03-30 14:05 UTC`) |
| Rotation owner recorded | PASS/FAIL | Name + team owning secret change |
| Active token var (`KLIENT_OPS_TOKEN_ACTIVE`) confirmed | PASS/FAIL | Secret/version reference; never paste token |
| Previous token overlap window documented (`KLIENT_OPS_TOKEN_PREVIOUS`) | PASS/FAIL/N/A | Start + planned removal timestamp |
| Previous token expiry/removal expectation recorded | PASS/FAIL | Removal SLA and ticket/runbook reference |

## 3) Evidence artifact links
Attach links or paths to the objective release evidence.

Use one canonical manifest link for approvers; include optional direct links only when a reviewer asks for a specific file.
Canonical required bundle contents are defined at `docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts`.
Strict E2E mode/fallback policy boundaries are defined at `docs/deployment-quick-reference.md#canonical-browser-gate-policy-ci--local`.
Evidence validation mode schema markers from `scripts/validate-release-evidence.mjs` (record whichever run context applies): `validationMode=local`, `validationMode=ci`, `validationMode=unpacked-artifact`.

| Evidence package | Artifact link or path |
|---|---|
| Release evidence manifest (required) | `artifacts/release-evidence/<release-id>/manifest.json` |
| Postdeploy checkpoints index (required for hypercare cadence evidence) | `artifacts/release-evidence/<release-id>/postdeploy-checkpoints.json` |
| UX/accessibility acceptance record (if applicable) | `<path-or-N/A>` |

Checkpoint citation guidance (required when multiple postdeploy runs exist):
- Treat `manifest.json` as the canonical approver entrypoint for latest status and use `postdeployCheckpoints.latestCheckpoint`/`postdeployCheckpoints.latestArtifacts` for current-state links.
- Use `postdeploy-checkpoints.json` (or `manifest.json` `postdeployCheckpoints.history`) to cite historical checkpoint timestamps and artifact paths in UTC.
- Include at least one explicit checkpoint timestamp in Section 7 rationale when mitigations or transient failures occurred.

Optional per-file links (if a reviewer requests drill-down):
- Include the strict hard-gate command transcript line exactly as executed when applicable: `RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master`.
- Include the strict release-blocking E2E command transcript line exactly as executed in CI: `RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e`.
- Use the canonical required artifact list in `docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts`.
- For E2E proof completeness, include `e2e-summary.json` fields `executionMode`, `details.artifacts.playwrightJsonReport.path`, `details.artifacts.playwrightJsonReport.valid`, and `details.artifacts.playwrightJsonReport.suiteCount`.
- Add any additional per-phase links relevant to this release (for example: `branch-parity.txt`, `backup.json`, `startup-failfast.json`, `restore.json`, `restore-drill.json`, `postdeploy-health.json`, `postdeploy-ready.json`, `postdeploy-exports-queue.json`, `postdeploy-telemetry-bundle.json`, `postdeploy-evaluation-summary.json`).

## 4) Rollback readiness
- **Pre-release backup artifact ID**: `<backup-id>`
- **Backup path**: `<backup-path>`
- **Backup SHA-256**: `<sha256>`
- **Restore drill status**: `<PASS/FAIL/NOT-RUN>`
- **Restore drill evidence**: `artifacts/release-evidence/<release-id>/restore-drill.json` (`executionMode=verify-only-drill`)
- **Live rollback evidence (if executed)**: `artifacts/release-evidence/<release-id>/restore.json` (`executionMode=live-restore`)

Decision rule (must match artifact + mode):
- Live rollback evidence: `restore.json` and `executionMode=live-restore`.
- Drill evidence only: `restore-drill.json` and `executionMode=verify-only-drill`.
- Never mark a live rollback as complete based on `restore-drill.json`.

## 5) Release notes snapshot
- **Key changes included**: `<summary>`
- **Known risks / mitigations**: `<summary>`
- **Feature flags touched**: `<summary>`
- **Customer-facing impact summary**: `<summary>`
- **Operator flow expectation updates**: `<note any UI/operator read-write expectation changes (draft collaborator management, template publish/revert visibility, exports queue controls) and reference updated UI contract + RBAC integration evidence>`

## 6) Approver signatures
All required approvers must sign before GO.

| Role | Name | Decision (GO/NO-GO) | Signed at (UTC) |
|---|---|---|---|
| Release Manager | `<name>` | `<GO/NO-GO>` | `<YYYY-MM-DD HH:MM>` |
| SRE / On-call | `<name>` | `<GO/NO-GO>` | `<YYYY-MM-DD HH:MM>` |
| QA Lead | `<name>` | `<GO/NO-GO>` | `<YYYY-MM-DD HH:MM>` |
| Security Owner | `<name>` | `<GO/NO-GO>` | `<YYYY-MM-DD HH:MM>` |
| Engineering Manager | `<name>` | `<GO/NO-GO>` | `<YYYY-MM-DD HH:MM>` |

## 7) Final decision
- **Decision**: `<GO/NO-GO>`
- **Decision timestamp (UTC)**: `<YYYY-MM-DD HH:MM>`
- **Decision rationale**: `<objective rationale tied to evidence>`

### 7a) Postdeploy checkpoint history log (hypercare + decision audit)
Use one row per `--phase postdeploy` execution. Copy timestamps/paths from `postdeploy-checkpoints.json`.

| Checkpoint timestamp (UTC) | Outcome (`passed`/`failed`) | Evidence artifacts cited | Notes / mitigations |
|---|---|---|---|
| `<YYYY-MM-DDTHH:MM:SS.sssZ>` | `<passed/failed>` | `<checkpoint artifact paths>` | `<what changed before next run>` |

## Documentation freshness owner
- **Owner**: `<team-or-role>`
- **Review cadence**: `<e.g., every release + monthly>`
- **Synchronization requirement**: Update this template, `docs/deployment-quick-reference.md`, and `docs/release-ready-checklist.md` whenever runtime validation commands, phases, thresholds, or artifact schemas change.
