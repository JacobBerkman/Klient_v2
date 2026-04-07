import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const filesToRead = {
  readme: 'README.md',
  quickRef: 'docs/deployment-quick-reference.md',
  checklist: 'docs/release-ready-checklist.md',
  handoff: 'docs/release-handoff-template.md',
  operationsUi: 'apps/web/public/app.js'
}

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

function fail(message) {
  process.stderr.write(`❌ ${message}\n`)
  process.exit(1)
}

function assertContains(content, needle, label) {
  if (!content.includes(needle)) fail(`${label} is missing required text: ${needle}`)
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
  assertContains(contentByKey.operationsUi, command, filesToRead.operationsUi)
}

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

process.stdout.write('✅ Release doc consistency checks passed.\n')
