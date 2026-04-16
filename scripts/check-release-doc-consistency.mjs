import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const filesToRead = {
  readme: 'README.md',
  quickRef: 'docs/deployment-quick-reference.md',
  checklist: 'docs/release-ready-checklist.md',
  handoff: 'docs/release-handoff-template.md',
  testMatrix: 'docs/release-flow-test-matrix.md'
}

const canonicalE2EEvidenceFields = [
  'executionMode',
  'details.artifacts.playwrightJsonReport.path',
  'details.artifacts.playwrightJsonReport.valid',
  'details.artifacts.playwrightJsonReport.suiteCount',
  'details.artifacts.playwrightEvidenceLinkage.reportPath',
  'details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath',
  'details.artifacts.playwrightEvidenceLinkage.provisioningVersion'
]

const canonicalArtifacts = [
  'validate-master-summary.json',
  'api-contract-summary.json',
  'integration-summary.json',
  'migration-summary.json',
  'smoke-summary.json',
  'security-summary.json',
  'e2e-summary.json'
]

const canonicalCommandLabels = [
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore --restore-path "$RESTORE_BACKUP_PATH"',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase restore-drill --restore-path "$RESTORE_BACKUP_PATH"'
]

const canonicalStrictGateCommands = [
  'RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master',
  "RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e"
]

const canonicalHardGateSequence = [
  'npm run check:syntax',
  'npm run check:conflicts',
  'npm run web:build',
  'npm run test:contract',
  'node scripts/integration-rbac.mjs',
  'node scripts/integration-tenancy.mjs',
  'npm run test:integration',
  'npm run check:migrations',
  'npm run test:smoke',
  'npm run test:ui-contract',
  'npm run test:e2e',
  'npm run test:security'
]

function fail(message) {
  process.stderr.write(`❌ ${message}\n`)
  process.exit(1)
}

function assertContains(content, needle, label) {
  if (!content.includes(needle)) fail(`${label} is missing required text: ${needle}`)
}

function assertContainsInOrder(content, orderedNeedles, label) {
  let previousIndex = -1
  for (const needle of orderedNeedles) {
    const index = content.indexOf(needle, previousIndex + 1)
    if (index === -1) {
      fail(`${label} is missing required ordered text: ${needle}`)
    }
    if (index < previousIndex) {
      fail(`${label} has out-of-order gate sequence text: ${needle}`)
    }
    previousIndex = index
  }
}

const contentByKey = Object.fromEntries(
  Object.entries(filesToRead).map(([key, filePath]) => [key, readFileSync(resolve(process.cwd(), filePath), 'utf8')])
)

for (const artifactName of canonicalArtifacts) {
  assertContains(contentByKey.quickRef, artifactName, filesToRead.quickRef)
  assertContains(contentByKey.checklist, artifactName, filesToRead.checklist)
}

for (const command of canonicalCommandLabels) {
  assertContains(contentByKey.quickRef, command, filesToRead.quickRef)
}

assertContainsInOrder(contentByKey.quickRef, canonicalHardGateSequence, filesToRead.quickRef)

assertContains(contentByKey.quickRef, 'npm run validate:master', filesToRead.quickRef)
assertContains(contentByKey.checklist, 'npm run validate:master', filesToRead.checklist)

assertContains(
  contentByKey.readme,
  'docs/deployment-quick-reference.md#canonical-operator-flow-exact-command-sequence',
  filesToRead.readme
)
assertContains(
  contentByKey.readme,
  'docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts',
  filesToRead.readme
)
assertContains(contentByKey.readme, 'apps/web/src', filesToRead.readme)
assertContains(contentByKey.readme, 'apps/web/public` is legacy-only', filesToRead.readme)
assertContains(contentByKey.quickRef, 'npm run web:build', filesToRead.quickRef)
assertContains(contentByKey.checklist, 'npm run web:build', filesToRead.checklist)
assertContains(
  contentByKey.checklist,
  'docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts',
  filesToRead.checklist
)
assertContains(
  contentByKey.handoff,
  'docs/deployment-quick-reference.md#canonical-release-evidence-bundle-required-artifacts',
  filesToRead.handoff
)

assertContains(
  contentByKey.checklist,
  'docs/deployment-quick-reference.md#canonical-hard-gate-sequence-validatemaster-exact-execution-order',
  filesToRead.checklist
)
assertContains(
  contentByKey.checklist,
  'docs/deployment-quick-reference.md#deterministic-post-deploy-validation-sequence',
  filesToRead.checklist
)
assertContains(
  contentByKey.handoff,
  'docs/deployment-quick-reference.md#canonical-hard-gate-sequence-validatemaster-exact-execution-order',
  filesToRead.handoff
)
assertContains(
  contentByKey.handoff,
  'docs/deployment-quick-reference.md#deterministic-post-deploy-validation-sequence',
  filesToRead.handoff
)

for (const e2eField of canonicalE2EEvidenceFields) {
  assertContains(contentByKey.quickRef, e2eField, filesToRead.quickRef)
  assertContains(contentByKey.checklist, e2eField, filesToRead.checklist)
  assertContains(contentByKey.handoff, e2eField, filesToRead.handoff)
  assertContains(contentByKey.testMatrix, e2eField, filesToRead.testMatrix)
}

for (const command of canonicalStrictGateCommands) {
  assertContains(contentByKey.quickRef, command, filesToRead.quickRef)
  assertContains(contentByKey.checklist, command, filesToRead.checklist)
  assertContains(contentByKey.handoff, command, filesToRead.handoff)
  assertContains(contentByKey.testMatrix, command, filesToRead.testMatrix)
}

process.stdout.write('✅ Release doc consistency checks passed.\n')
