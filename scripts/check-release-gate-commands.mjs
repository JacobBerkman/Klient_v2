import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageJsonPath = resolve(process.cwd(), 'package.json')
const workflowPath = resolve(process.cwd(), '.github/workflows/smoke.yml')
const checklistPath = resolve(process.cwd(), 'docs/release-ready-checklist.md')
const quickRefPath = resolve(process.cwd(), 'docs/deployment-quick-reference.md')

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const scripts = pkg.scripts || {}
const workflow = readFileSync(workflowPath, 'utf8')
const checklist = readFileSync(checklistPath, 'utf8')
const quickRef = readFileSync(quickRefPath, 'utf8')

const requiredScripts = [
  'validate:master',
  'release:go-no-go',
  'check:release-docs',
  'test:contract',
  'test:integration',
  'check:migrations',
  'test:smoke',
  'test:e2e',
  'test:security',
  'test:ui-contract'
]

const releaseGateJobs = [
  {
    jobId: 'api_contract',
    command: 'npm run test:contract',
    evidence: 'artifacts/release-evidence/<release-id>/api-contract-summary.json'
  },
  {
    jobId: 'full_integration',
    command: 'npm run test:integration',
    evidence: 'artifacts/release-evidence/<release-id>/integration-summary.json'
  },
  {
    jobId: 'migration_checks',
    command: 'npm run check:migrations',
    evidence: 'artifacts/release-evidence/<release-id>/migration-summary.json'
  },
  {
    jobId: 'smoke_runtime_contract',
    command: 'npm run test:smoke',
    evidence: 'artifacts/release-evidence/<release-id>/smoke-summary.json'
  },
  {
    jobId: 'e2e_release_blocking',
    command: 'npm run test:e2e',
    evidence: 'artifacts/release-evidence/<release-id>/e2e-summary.json'
  },
  {
    jobId: 'security_checks',
    command: 'npm run test:security',
    evidence: 'artifacts/release-evidence/<release-id>/security-summary.json'
  }
]

const requiredGateCommands = [
  'npm run validate:master',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy'
]

const missing = []
for (const scriptName of requiredScripts) {
  if (!scripts[scriptName]) missing.push(`missing package.json script: ${scriptName}`)
}

function assertContains(content, needle, label) {
  if (!content.includes(needle)) missing.push(`${label} missing command: ${needle}`)
}

for (const cmd of requiredGateCommands) {
  assertContains(quickRef, cmd, 'docs/deployment-quick-reference.md')
  assertContains(checklist, cmd, 'docs/release-ready-checklist.md')
}

for (const { command, evidence } of releaseGateJobs) {
  assertContains(quickRef, command, 'docs/deployment-quick-reference.md')
  assertContains(quickRef, evidence, 'docs/deployment-quick-reference.md')
  assertContains(checklist, command, 'docs/release-ready-checklist.md')
  assertContains(checklist, evidence, 'docs/release-ready-checklist.md')
  assertContains(workflow, command, '.github/workflows/smoke.yml')
}

for (const { jobId } of releaseGateJobs) {
  assertContains(workflow, `${jobId}:`, '.github/workflows/smoke.yml')
  assertContains(workflow, `- ${jobId}`, '.github/workflows/smoke.yml merge gate needs')
}

assertContains(workflow, 'npm run validate:master', '.github/workflows/smoke.yml')
assertContains(workflow, 'npm run check:release-docs', '.github/workflows/smoke.yml')
assertContains(workflow, 'npm run check:release-gate-commands', '.github/workflows/smoke.yml')

if (workflow.includes('npm run test:runtime-contract')) {
  missing.push('.github/workflows/smoke.yml uses non-canonical command: npm run test:runtime-contract')
}

const nodeFileMatchers = [/^node\s+([^\s]+\.mjs)$/, /^bash\s+([^\s]+\.sh)$/]
for (const [name, command] of Object.entries(scripts)) {
  for (const matcher of nodeFileMatchers) {
    const match = command.match(matcher)
    if (!match) continue
    const targetPath = resolve(process.cwd(), match[1])
    if (!existsSync(targetPath)) {
      missing.push(`script ${name} targets missing file: ${match[1]}`)
    }
  }
}

if (missing.length > 0) {
  for (const entry of missing) {
    process.stderr.write(`❌ ${entry}\n`)
  }
  process.exit(1)
}

process.stdout.write('✅ Release gate command presence/callability checks passed.\n')
