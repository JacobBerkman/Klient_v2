# Release Handoff Template

Use this handoff package for every production release so engineering, SRE, and approvers review one consistent record.

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
| `APP_SECRET` |  |  |
| `NODE_ENV` |  |  |
| `PORT` |  |  |
| `HOST` |  |  |
| `LOG_LEVEL` |  |  |
| `ENABLE_DEMO_MODE` |  |  |
| `KLIENT_BASE_URL` |  |  |
| `KLIENT_OPS_TOKEN` |  |  |
| `PII_KEY_PROVIDER` (if used) |  |  |
| `PII_KMS_KEY_ALIAS` (if `PII_KEY_PROVIDER=kms`) |  |  |
| `PII_KMS_ACTIVE_KEY_ID` (if `PII_KEY_PROVIDER=kms`) |  |  |
| `PII_KMS_KEYRING` (if `PII_KEY_PROVIDER=kms`) |  |  |

## 3) Evidence artifact links
Attach links or paths to the objective release evidence.

| Gate / Check | Artifact link or path |
|---|---|
| `validate:master` summary | `artifacts/release-evidence/<release-id>/validate-master-summary.json` |
| API contract summary | `artifacts/release-evidence/<release-id>/api-contract-summary.json` |
| Integration summary | `artifacts/release-evidence/<release-id>/integration-summary.json` |
| Migration summary | `artifacts/release-evidence/<release-id>/migration-summary.json` |
| Smoke summary | `artifacts/release-evidence/<release-id>/smoke-summary.json` |
| Security summary | `artifacts/release-evidence/<release-id>/security-summary.json` |
| Branch parity output | `artifacts/release-evidence/<release-id>/branch-parity.txt` |
| Backup metadata | `artifacts/release-evidence/<release-id>/backup.json` |
| Post-deploy health | `artifacts/release-evidence/<release-id>/postdeploy-health.json` |
| Post-deploy readiness | `artifacts/release-evidence/<release-id>/postdeploy-ready.json` |
| Post-deploy exports queue | `artifacts/release-evidence/<release-id>/postdeploy-exports-queue.json` |
| Post-deploy telemetry bundle | `artifacts/release-evidence/<release-id>/postdeploy-telemetry-bundle.json` |

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
