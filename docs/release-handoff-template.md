# Release Handoff — release-20260330-1400

Use this handoff package for every production release so engineering, SRE, and approvers review one consistent record.
For exact operator commands and diagnostics triage, pair this template with `docs/deployment-quick-reference.md`.

Architecture note: this release process assumes the existing single-process **Node + SQLite + static web** deployment model (no split app-tier/database migration in this template).

## 1) Release identity
- **Release ID**: `release-20260330-1400`
- **Environment**: `production`
- **Release manager**: Jordan Lee
- **Deployment window (UTC)**: 2026-03-30 14:00-15:00
- **Commit / tag**: `c3f4d9a` / `release-20260330-1400`
- **Container image**: `ghcr.io/klient/klient-v2:release-20260330-1400`
- **Image digest**: `sha256:9bfa9b8f06c4cc6e4ad7a69cccf128d982f5aac3b5ba2ec84dc0e863d0ee80da`

Release identity collection checklist (fill before GO/NO-GO):
- `Release ID`: match the `RELEASE_ID` environment variable used for artifact generation.
- `Environment`: must be an explicit deploy target (`staging` or `production`).
- `Commit / tag`: record the immutable git commit SHA (or signed tag that resolves to a commit).
- `Image digest`: record the immutable OCI digest actually deployed (`sha256:...`), not a mutable image tag.

## 2) Required environment keys (presence check)
Record whether each required key is set in the deployment target (do not paste secret values).

| Key | Present (Y/N) | Notes |
|---|---|---|
| `APP_SECRET` | Y | Explicitly injected via secret manager; no default fallback |
| `AUTH_PROVIDER` | Y | `oidc` in production |
| `NODE_ENV` | Y | `production` |
| `PORT` | Y | `3000` |
| `HOST` | Y | `0.0.0.0` |
| `LOG_LEVEL` | Y | `info` |
| `ENABLE_DEMO_MODE` | Y | `false` |
| `KLIENT_BASE_URL` | Y | Public production URL configured |
| `KLIENT_OPS_TOKEN` | Y | Rotated token injected from secret store |
| `PII_KEY_PROVIDER` | Y | `kms` |
| `PII_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=env`) | N/A | Not required for KMS mode |
| `PII_KEYRING` (if `PII_KEY_PROVIDER=env`) | N/A | Not required for KMS mode |
| `PII_KMS_KEY_ALIAS` (if `PII_KEY_PROVIDER=kms`) | Y | Alias configured |
| `PII_KMS_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=kms`) | Y | Active key ID present |
| `PII_KMS_KEYRING` (if `PII_KEY_PROVIDER=kms`) | Y | KMS keyring configured |


## 2a) Startup fail-fast verification (production)
Confirm that startup fails before bind/listen when runtime config is invalid, and records clear issues.
Use `artifacts/release-evidence/<release-id>/startup-failfast.json` as the default evidence source from `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight`.

| Check | Result | Evidence path / notes |
|---|---|---|
| Invalid production config blocks startup (`server.startup.blocked`) | PASS | `artifacts/release-evidence/release-20260330-1400/startup-failfast.json` (`checks.startupBlockedLogged=true`) |
| Error payload lists startup validation issues | PASS | `artifacts/release-evidence/release-20260330-1400/startup-failfast.json` (`checks.startupIssuesPresent=true`) |
| Startup is blocked before bind/listen | PASS | `artifacts/release-evidence/release-20260330-1400/startup-failfast.json` (`checks.listenPrevented=true`) |

## 3) Evidence artifact links
Attach links or paths to the objective release evidence.

Use one canonical manifest link for approvers; include optional direct links only when a reviewer asks for a specific file.

| Evidence package | Artifact link or path |
|---|---|
| Release evidence manifest (required) | `artifacts/release-evidence/<release-id>/manifest.json` |
| UX/accessibility acceptance record (RC journeys) | `docs/rc-web-journeys-acceptance-YYYY-MM-DD.md` |

Optional per-file links (if needed for review):
- `artifacts/release-evidence/<release-id>/validate-master-summary.json`
- `artifacts/release-evidence/<release-id>/api-contract-summary.json`
- `artifacts/release-evidence/<release-id>/integration-summary.json`
- `artifacts/release-evidence/<release-id>/migration-summary.json`
- `artifacts/release-evidence/<release-id>/smoke-summary.json`
- `artifacts/release-evidence/<release-id>/security-summary.json`
- `artifacts/release-evidence/<release-id>/branch-parity.txt`
- `artifacts/release-evidence/<release-id>/backup.json`
- `artifacts/release-evidence/<release-id>/startup-failfast.json`
- `artifacts/release-evidence/<release-id>/startup-failfast.txt`
- `artifacts/release-evidence/<release-id>/restore.json`
- `artifacts/release-evidence/<release-id>/restore-drill.json`
- `artifacts/release-evidence/<release-id>/postdeploy-health.json`
- `artifacts/release-evidence/<release-id>/postdeploy-ready.json`
- `artifacts/release-evidence/<release-id>/postdeploy-exports-queue.json`
- `artifacts/release-evidence/<release-id>/postdeploy-telemetry-bundle.json`

## 4) Rollback readiness
- **Pre-release backup artifact ID**: `backup-20260330-133015`
- **Backup path**: `data/backup-20260330-133015.db`
- **Backup SHA-256**: `4fe3b8fc258ea1a108ecd1632cbb62dc495f4f1aee9e571523e58e6b5ea31f21`
- **Restore drill status**: `PASS`
- **Restore drill evidence**: `artifacts/release-evidence/release-20260330-1400/restore-drill.json` (`executionMode=verify-only-drill`)
- **Live rollback evidence (if executed)**: `artifacts/release-evidence/release-20260330-1400/restore.json` (`executionMode=live-restore`, not executed during normal rollout)

Decision rule (must match artifact + mode):
- Live rollback evidence: `restore.json` and `executionMode=live-restore`.
- Drill evidence only: `restore-drill.json` and `executionMode=verify-only-drill`.
- Never mark a live rollback as complete based on `restore-drill.json`.

## 5) Release notes snapshot
- **Key changes included**: Startup fail-fast enforcement evidence integrated in preflight, release evidence manifest includes per-phase checksums, post-deploy telemetry bundle capture hardened, and release gate sequencing clarified for backup/restore validation.
- **Known risks / mitigations**: Risk of delayed queue processing immediately after deploy; mitigation is active monitoring of `postdeploy-exports-queue.json` with rollback trigger if stalled >10 minutes. Risk of latent config drift; mitigation is mandatory preflight startup-failfast probe and branch parity gating.
- **Feature flags touched**: `ENABLE_DEMO_MODE` reviewed and remains `false` in production; no new runtime feature flags introduced in this release.
- **Customer-facing impact summary**: No user-facing UI workflow changes expected. Customers may see improved reliability in startup configuration validation and operational recovery readiness, with no planned downtime beyond standard rolling deploy behavior.

## 6) Approver signatures
All required approvers must sign before GO.

| Role | Name | Decision (GO/NO-GO) | Signed at (UTC) |
|---|---|---|---|
| Release Manager | Jordan Lee | GO | 2026-03-30 14:44 |
| SRE / On-call | Priya Natarajan | GO | 2026-03-30 14:46 |
| QA Lead | Mateo Ruiz | GO | 2026-03-30 14:47 |
| Security Owner | Aisha Khan | GO | 2026-03-30 14:48 |
| Engineering Manager | Elena Petrova | GO | 2026-03-30 14:49 |

## 7) Final decision
- **Decision**: `GO`
- **Decision timestamp (UTC)**: 2026-03-30 14:50
- **Decision rationale**: All mandatory preflight and post-deploy evidence artifacts are present under the canonical manifest, startup fail-fast checks passed, rollback drill passed with integrity validation, and all required approvers recorded GO decisions within the deployment window.
