import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageJsonPath = resolve(process.cwd(), 'package.json')
const workflowPath = resolve(process.cwd(), '.github/workflows/smoke.yml')
const checklistPath = resolve(process.cwd(), 'docs/release-ready-checklist.md')
const testMatrixPath = resolve(process.cwd(), 'docs/release-flow-test-matrix.md')
const quickRefPath = resolve(process.cwd(), 'docs/deployment-quick-reference.md')
const handoffPath = resolve(process.cwd(), 'docs/release-handoff-template.md')

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const scripts = pkg.scripts || {}
const workflow = readFileSync(workflowPath, 'utf8')
const checklist = readFileSync(checklistPath, 'utf8')
const testMatrix = readFileSync(testMatrixPath, 'utf8')
const quickRef = readFileSync(quickRefPath, 'utf8')
const handoff = readFileSync(handoffPath, 'utf8')

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
const canonicalEvidenceSummaries = [
  'api-contract-summary.json',
  'integration-summary.json',
  'migration-summary.json',
  'smoke-summary.json',
  'e2e-summary.json',
  'security-summary.json'
]

const requiredGateFiles = [
  'scripts/master-validate.mjs',
  'scripts/master-integration.mjs',
  'scripts/runner-lifecycle.mjs',
  'scripts/validate-release-evidence.mjs',
  'scripts/package-release-evidence.mjs'
]

const requiredGateCommands = [
  'npm run validate:master',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase preflight',
  'npm run release:go-no-go -- --release-id "$RELEASE_ID" --phase postdeploy'
]

const requiredStrictGateCommands = [
  'RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master',
  "RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e"
]

const requiredEvidenceValidationModes = ['validationMode=local', 'validationMode=ci', 'validationMode=unpacked-artifact']

const missing = []
for (const scriptName of requiredScripts) {
  if (!scripts[scriptName]) missing.push(`missing package.json script: ${scriptName}`)
}

function assertContains(content, needle, label) {
  if (!content.includes(needle)) missing.push(`${label} missing command: ${needle}`)
}

function getJobBlock(content, jobId) {
  const matcher = new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_]+:\\n|$)`)
  const match = content.match(matcher)
  if (!match) {
    missing.push(`.github/workflows/smoke.yml missing job: ${jobId}`)
    return ''
  }
  return match[1]
}

for (const cmd of requiredGateCommands) {
  assertContains(quickRef, cmd, 'docs/deployment-quick-reference.md')
  assertContains(checklist, cmd, 'docs/release-ready-checklist.md')
}

for (const cmd of requiredStrictGateCommands) {
  assertContains(quickRef, cmd, 'docs/deployment-quick-reference.md')
  assertContains(checklist, cmd, 'docs/release-ready-checklist.md')
  assertContains(testMatrix, cmd, 'docs/release-flow-test-matrix.md')
}

for (const modeMarker of requiredEvidenceValidationModes) {
  assertContains(quickRef, modeMarker, 'docs/deployment-quick-reference.md')
  assertContains(checklist, modeMarker, 'docs/release-ready-checklist.md')
  assertContains(testMatrix, modeMarker, 'docs/release-flow-test-matrix.md')
  assertContains(handoff, modeMarker, 'docs/release-handoff-template.md')
}

for (const { command, evidence } of releaseGateJobs) {
  assertContains(quickRef, command, 'docs/deployment-quick-reference.md')
  assertContains(quickRef, evidence, 'docs/deployment-quick-reference.md')
  assertContains(checklist, command, 'docs/release-ready-checklist.md')
  assertContains(checklist, evidence, 'docs/release-ready-checklist.md')
  assertContains(workflow, command, '.github/workflows/smoke.yml')
  if (!evidence.startsWith('artifacts/release-evidence/<release-id>/')) {
    missing.push(`release gate evidence path must be rooted at artifacts/release-evidence/<release-id>/: ${evidence}`)
  }
  if (!evidence.endsWith('-summary.json')) {
    missing.push(`release gate evidence path must end with -summary.json: ${evidence}`)
  }
}

for (const { jobId } of releaseGateJobs) {
  assertContains(workflow, `${jobId}:`, '.github/workflows/smoke.yml')
  assertContains(workflow, `- ${jobId}`, '.github/workflows/smoke.yml merge gate needs')
}

assertContains(workflow, 'npm run validate:master', '.github/workflows/smoke.yml')
assertContains(workflow, 'npm run check:release-docs', '.github/workflows/smoke.yml')
assertContains(workflow, 'npm run check:release-gate-commands', '.github/workflows/smoke.yml')

const e2eReleaseJob = getJobBlock(workflow, 'e2e_release_blocking')
if (e2eReleaseJob) {
  const mkdirMatch = e2eReleaseJob.match(/mkdir -p (artifacts\/[^\s]+)/)
  if (!mkdirMatch) {
    missing.push('.github/workflows/smoke.yml e2e_release_blocking missing mkdir -p artifacts path')
  } else {
    const artifactBase = mkdirMatch[1]
    const escapedBase = artifactBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`\\}\\s*>\\s*${escapedBase}/readiness-summary\\.md`).test(e2eReleaseJob)) {
      missing.push('.github/workflows/smoke.yml e2e_release_blocking readiness-summary path differs from mkdir path')
    }
    if (!new RegExp(`tee\\s+${escapedBase}/suite\\.log`).test(e2eReleaseJob)) {
      missing.push('.github/workflows/smoke.yml e2e_release_blocking suite log path differs from mkdir path')
    }
    if (!new RegExp(`\\n\\s*${escapedBase}/\\*\\*\\n`).test(e2eReleaseJob)) {
      missing.push('.github/workflows/smoke.yml e2e_release_blocking artifact upload path differs from mkdir path')
    }
  }
}

const hardReleaseJob = getJobBlock(workflow, 'hard_release_gate')
if (hardReleaseJob) {
  const playwrightInstallIndex = hardReleaseJob.indexOf('npx playwright install --with-deps chromium')
  const validateMasterIndex = hardReleaseJob.indexOf('npm run validate:master')
  if (playwrightInstallIndex < 0) {
    missing.push('.github/workflows/smoke.yml hard_release_gate missing Playwright install step')
  }
  if (validateMasterIndex < 0) {
    missing.push('.github/workflows/smoke.yml hard_release_gate missing npm run validate:master')
  }
  if (playwrightInstallIndex >= 0 && validateMasterIndex >= 0 && playwrightInstallIndex > validateMasterIndex) {
    missing.push('.github/workflows/smoke.yml hard_release_gate installs Playwright after validate:master (must be before)')
  }
  if (!/RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master/.test(hardReleaseJob)) {
    missing.push('.github/workflows/smoke.yml hard_release_gate must execute validate:master with strict E2E env flags')
  }
  if (!hardReleaseJob.includes('- strict mode: RELEASE_E2E_STRICT_MODE=1')) {
    missing.push('.github/workflows/smoke.yml hard_release_gate readiness summary missing strict mode evidence line')
  }
  if (!hardReleaseJob.includes('- fallback: RELEASE_E2E_ALLOW_FALLBACK=0')) {
    missing.push('.github/workflows/smoke.yml hard_release_gate readiness summary missing fallback-disabled evidence line')
  }
}

const e2eReleaseBlockingJob = getJobBlock(workflow, 'e2e_release_blocking')
if (e2eReleaseBlockingJob) {
  if (!/RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e/.test(e2eReleaseBlockingJob)) {
    missing.push('.github/workflows/smoke.yml e2e_release_blocking must run test:e2e with strict mode and fallback disabled')
  }
  if (!e2eReleaseBlockingJob.includes('- strict mode: RELEASE_E2E_STRICT_MODE=1')) {
    missing.push('.github/workflows/smoke.yml e2e_release_blocking readiness summary missing strict mode evidence line')
  }
  if (!e2eReleaseBlockingJob.includes('- fallback: RELEASE_E2E_ALLOW_FALLBACK=0')) {
    missing.push('.github/workflows/smoke.yml e2e_release_blocking readiness summary missing fallback-disabled evidence line')
  }
}

const jobIds = new Set([...workflow.matchAll(/^  ([a-z0-9_]+):$/gm)].map((entry) => entry[1]))
const mergeGateJob = getJobBlock(workflow, 'merge_gate')
if (mergeGateJob) {
  const needsBlockMatch = mergeGateJob.match(/\n    needs:\n([\s\S]*?)\n    if:/)
  if (!needsBlockMatch) {
    missing.push('.github/workflows/smoke.yml merge_gate missing needs block')
  } else {
    const dependencies = [...needsBlockMatch[1].matchAll(/^\s+- ([a-z0-9_]+)$/gm)].map((entry) => entry[1])
    if (dependencies.length === 0) {
      missing.push('.github/workflows/smoke.yml merge_gate needs block is empty')
    }
    for (const dependency of dependencies) {
      if (!jobIds.has(dependency)) {
        missing.push(`.github/workflows/smoke.yml merge_gate needs includes unknown job: ${dependency}`)
      }
    }
  }
}

const e2eDocsFolder = 'artifacts/e2e-release-blocking'
assertContains(quickRef, `${e2eDocsFolder}/`, 'docs/deployment-quick-reference.md')
for (const summaryName of canonicalEvidenceSummaries) {
  assertContains(quickRef, `artifacts/release-evidence/<release-id>/${summaryName}`, 'docs/deployment-quick-reference.md')
  assertContains(checklist, `artifacts/release-evidence/<release-id>/${summaryName}`, 'docs/release-ready-checklist.md')
}

if (workflow.includes('npm run test:runtime-contract')) {
  missing.push('.github/workflows/smoke.yml uses non-canonical command: npm run test:runtime-contract')
}

for (const relativePath of requiredGateFiles) {
  if (!existsSync(resolve(process.cwd(), relativePath))) {
    missing.push(`required release gate file missing: ${relativePath}`)
  }
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
