# Release Handoff Template

Use this handoff package for every production release so engineering, SRE, and approvers review one consistent record.
For exact operator commands and diagnostics triage, pair this template with `docs/deployment-quick-reference.md`.

Architecture note: this release process assumes the existing single-process **Node + SQLite + static web** deployment model (no split app-tier/database migration in this template).

## 1) Release identity
- **Release ID**: `release-YYYYMMDD-HHMM`  
- **Environment**: `staging | production`  
- **Release manager**:  
- **Deployment window (UTC)**:  
- **Commit / tag**:  
- **Container image**:  
- **Image digest**: `sha256:...`

## 2) Required environment keys (presence check)
Record whether each required key is set in the deployment target (do not paste secret values).

| Key | Present (Y/N) | Notes |
|---|---|---|
| `APP_SECRET` |  | Explicitly injected; no default fallback allowed |
| `AUTH_PROVIDER` |  | Required in production (`local`, `oidc`, or `saml`) |
| `NODE_ENV` |  |  |
| `PORT` |  |  |
| `HOST` |  |  |
| `LOG_LEVEL` |  |  |
| `ENABLE_DEMO_MODE` |  |  |
| `KLIENT_BASE_URL` |  |  |
| `KLIENT_OPS_TOKEN` |  |  |
| `PII_KEY_PROVIDER` |  | Required mode selection (`env` or `kms`) |
| `PII_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=env`) |  |  |
| `PII_KEYRING` (if `PII_KEY_PROVIDER=env`) |  |  |
| `PII_KMS_KEY_ALIAS` (if `PII_KEY_PROVIDER=kms`) |  |  |
| `PII_KMS_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=kms`) |  |  |
| `PII_KMS_KEYRING` (if `PII_KEY_PROVIDER=kms`) |  |  |


## 2a) Startup fail-fast verification (production)
Confirm that startup fails before bind/listen when runtime config is invalid, and records clear issues.
Use `artifacts/release-evidence/<release-id>/startup-failfast.json` as the default evidence source from `npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight`.

| Check | Result | Evidence path / notes |
|---|---|---|
| Invalid production config blocks startup (`server.startup.blocked`) |  | `artifacts/release-evidence/<release-id>/startup-failfast.json` (`checks.startupBlockedLogged=true`) |
| Error payload lists startup validation issues |  | `artifacts/release-evidence/<release-id>/startup-failfast.json` (`checks.startupIssuesPresent=true`) |
| Startup is blocked before bind/listen |  | `artifacts/release-evidence/<release-id>/startup-failfast.json` (`checks.listenPrevented=true`) |

## 3) Evidence artifact links
Attach links or paths to the objective release evidence.

Use one canonical manifest link for approvers; include optional direct links only when a reviewer asks for a specific file.

| Evidence package | Artifact link or path |
|---|---|
| Release evidence manifest (required) | `artifacts/release-evidence/<release-id>/manifest.json` |

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
- `artifacts/release-evidence/<release-id>/postdeploy-health.json`
- `artifacts/release-evidence/<release-id>/postdeploy-ready.json`
- `artifacts/release-evidence/<release-id>/postdeploy-exports-queue.json`
- `artifacts/release-evidence/<release-id>/postdeploy-telemetry-bundle.json`

## 4) Rollback readiness
- **Pre-release backup artifact ID**:  
- **Backup path**: `data/backup-<timestamp>.db`  
- **Backup SHA-256**:  
- **Restore drill status**: `PASS | FAIL | NOT-RUN`  
- **Restore evidence**: `artifacts/release-evidence/<release-id>/restore.json`

## 5) Release notes snapshot
- **Key changes included**:  
- **Known risks / mitigations**:  
- **Feature flags touched**:  
- **Customer-facing impact summary**:  

## 6) Approver signatures
All required approvers must sign before GO.

| Role | Name | Decision (GO/NO-GO) | Signed at (UTC) |
|---|---|---|---|
| Release Manager |  |  |  |
| SRE / On-call |  |  |  |
| QA Lead |  |  |  |
| Security Owner |  |  |  |
| Engineering Manager |  |  |  |

## 7) Final decision
- **Decision**: `GO | NO-GO`
- **Decision timestamp (UTC)**:
- **Decision rationale**:
