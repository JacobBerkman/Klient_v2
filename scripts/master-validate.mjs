import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runCommandProcess } from './runner-lifecycle.mjs'

const defaultEvidenceDir = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_DIR || 'artifacts/release-evidence')

function isGitCheckout(cwd = process.cwd()) {
  return existsSync(resolve(cwd, '.git'))
}

function shouldIncludeMergeParityStep() {
  if (process.env.VALIDATE_MASTER_FORCE_MERGE_PARITY === '1') return true
  if (!isGitCheckout()) return false
  const branchCheck = spawnSync('git', ['rev-parse', '--verify', 'main'], { stdio: 'ignore' })
  return branchCheck.status === 0
}

const baseGateStepDefinitions = {
  'Static syntax checks': { command: 'npm', args: ['run', 'check:syntax'], evidenceFile: null },
  'Conflict marker guard': { command: 'npm', args: ['run', 'check:conflicts'], evidenceFile: null },
  'API contract tests': {
    command: 'npm',
    args: ['run', 'test:contract'],
    evidenceFile: resolve(defaultEvidenceDir, 'api-contract-summary.json')
  },
  'Negative-path RBAC checks': { command: 'node', args: ['scripts/integration-rbac.mjs'], evidenceFile: null },
  'Negative-path tenancy checks': {
    command: 'node',
    args: ['scripts/integration-tenancy.mjs'],
    evidenceFile: null
  },
  'Integration suites': {
    command: 'npm',
    args: ['run', 'test:integration'],
    evidenceFile: resolve(defaultEvidenceDir, 'integration-summary.json')
  },
  'Aggregate handoff regression': { command: 'npm', args: ['run', 'test:integration:handoff'], evidenceFile: null },
  'Migration order checks': {
    command: 'npm',
    args: ['run', 'check:migrations'],
    evidenceFile: resolve(defaultEvidenceDir, 'migration-summary.json')
  },
  'Smoke test': { command: 'npm', args: ['run', 'test:smoke'], evidenceFile: resolve(defaultEvidenceDir, 'smoke-summary.json') },
  'UI contract checks': { command: 'npm', args: ['run', 'test:ui-contract'], evidenceFile: null },
  'E2E browser checks': { command: 'npm', args: ['run', 'test:e2e'], evidenceFile: resolve(defaultEvidenceDir, 'e2e-summary.json') },
  'Security checks': { command: 'npm', args: ['run', 'test:security'], evidenceFile: resolve(defaultEvidenceDir, 'security-summary.json') }
}

const BASE_GATE_ORDER = Object.freeze([
  'Static syntax checks',
  'Conflict marker guard',
  'API contract tests',
  'Negative-path RBAC checks',
  'Negative-path tenancy checks',
  'Integration suites',
  'Aggregate handoff regression',
  'Migration order checks',
  'Smoke test',
  'UI contract checks',
  'E2E browser checks',
  'Security checks'
])

function buildOrderedSteps(order, definitions) {
  return Object.freeze(
    order.map((name) => {
      const step = definitions[name]
      if (!step) throw new Error(`Missing gate step definition: ${name}`)
      return Object.freeze({ name, ...step })
    })
  )
}

function assertOrderedInvariant(steps, expectedOrder, label) {
  const observed = steps.map((step) => step.name)
  if (observed.length !== expectedOrder.length) {
    throw new Error(`${label} command sequence length drifted. expected=${expectedOrder.length} actual=${observed.length}`)
  }
  for (let index = 0; index < expectedOrder.length; index += 1) {
    if (observed[index] !== expectedOrder[index]) {
      throw new Error(
        `${label} command sequence changed at index ${index}. expected="${expectedOrder[index]}" actual="${observed[index]}"`
      )
    }
  }
}

const baseGateSteps = buildOrderedSteps(BASE_GATE_ORDER, baseGateStepDefinitions)
assertOrderedInvariant(baseGateSteps, BASE_GATE_ORDER, 'baseGateSteps')

const includeMergeParityStep = shouldIncludeMergeParityStep()

const gateSteps = includeMergeParityStep
  ? Object.freeze([...baseGateSteps, { name: 'Merge/main parity check', command: 'npm', args: ['run', 'check:merge-main'], evidenceFile: null }])
  : baseGateSteps
assertOrderedInvariant(
  gateSteps,
  includeMergeParityStep ? [...BASE_GATE_ORDER, 'Merge/main parity check'] : BASE_GATE_ORDER,
  'gateSteps'
)

if (!includeMergeParityStep) {
  process.stdout.write(
    '\nℹ️ Skipping merge/main parity check because this workspace is missing required git metadata (no .git or no local main branch).\n'
  )
}


function resolveGateStepsFromEnv() {
  const rawFilter = process.env.VALIDATE_MASTER_STEPS
  if (!rawFilter) return gateSteps

  const requested = rawFilter
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  if (requested.length === 0) return gateSteps

  const selected = gateSteps.filter((step) => {
    const slug = step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    return requested.includes(slug) || requested.includes(step.name.toLowerCase())
  })

  if (selected.length === 0) {
    throw new Error(`VALIDATE_MASTER_STEPS did not match any gate steps: ${rawFilter}`)
  }

  return selected
}
function formatCommand(step) {
  return `${step.command} ${step.args.join(' ')}`
}

function envForStep(step) {
  const env = { ...process.env, RELEASE_EVIDENCE_DIR: defaultEvidenceDir }
  if (step.evidenceFile && step.name === 'API contract tests') env.RELEASE_EVIDENCE_CONTRACT_FILE = step.evidenceFile
  if (step.evidenceFile && step.name === 'Integration suites') env.RELEASE_EVIDENCE_INTEGRATION_FILE = step.evidenceFile
  if (step.evidenceFile && step.name === 'Migration order checks') env.RELEASE_EVIDENCE_MIGRATION_FILE = step.evidenceFile
  if (step.evidenceFile && step.name === 'Smoke test') env.RELEASE_EVIDENCE_SMOKE_FILE = step.evidenceFile
  if (step.evidenceFile && step.name === 'E2E browser checks') {
    env.RELEASE_EVIDENCE_E2E_FILE = step.evidenceFile
    env.RELEASE_E2E_STRICT_MODE = '1'
    env.RELEASE_E2E_ALLOW_FALLBACK = '0'
    env.PLAYWRIGHT_JSON_REPORT = resolve(defaultEvidenceDir, 'playwright-report.json')
    env.RELEASE_E2E_PLAYWRIGHT_REPORT = env.PLAYWRIGHT_JSON_REPORT
  }
  if (step.evidenceFile && step.name === 'Security checks') env.RELEASE_EVIDENCE_SECURITY_FILE = step.evidenceFile
  return env
}

function timeoutForStep(step) {
  if (step.name === 'Aggregate handoff regression') {
    return Number.parseInt(process.env.VALIDATE_MASTER_HANDOFF_TIMEOUT_MS || '240000', 10)
  }
  return 0
}

async function runStep(step, index, total) {
  process.stdout.write(`\n$ ${formatCommand(step)}\n`)

  try {
    return await runCommandProcess({
      command: step.command,
      args: step.args,
      label: step.name,
      index,
      total,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: envForStep(step),
      timeoutMs: timeoutForStep(step)
    })
  } catch (error) {
    const message = String(error?.message || error)
    const matchedExitCode = message.match(/exited with code (\d+)/)
    if (matchedExitCode) {
      error.exitCode = Number.parseInt(matchedExitCode[1], 10)
    }
    throw error
  }
}

function toIsoTimestamp(dateValue) {
  return new Date(dateValue).toISOString()
}

function buildFailureMessage({ failureError, failedStep }) {
  const defaultMessage = String(failureError?.message || failureError)
  if (!failedStep) {
    return defaultMessage
  }

  if (failedStep.name === 'Aggregate handoff regression') {
    const remediation =
      'Remediation hints: rerun `npm run test:integration:handoff`, confirm INTEGRATION_SUITES ordering is `integration-templates.mjs,integration-exports.mjs`, and inspect `scripts/integration-aggregate-exports-handoff.mjs` timeout/error context.'
    return `${defaultMessage}\nAggregate handoff regression failed. ${remediation}`
  }

  if (failedStep.name !== 'E2E browser checks') {
    return defaultMessage
  }

  const evidenceLocation = failedStep.evidenceFile || resolve(defaultEvidenceDir, 'e2e-summary.json')
  const remediation =
    'Remediation hints: run `npx playwright install --with-deps chromium`, confirm Chromium is available, verify RELEASE_E2E_STRICT_MODE=1 and RELEASE_E2E_ALLOW_FALLBACK=0, and rerun `npm run test:e2e`.'

  return `${defaultMessage}\nE2E browser checks failed. ${remediation}\nEvidence file: ${evidenceLocation}`
}

const results = []
let failure = null
const startedAt = Date.now()

const stepsToRun = resolveGateStepsFromEnv()

for (let index = 0; index < stepsToRun.length; index += 1) {
  const step = stepsToRun[index]
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await runStep(step, index, stepsToRun.length)
    results.push({
      ...step,
      status: 'passed',
      durationMs: result.durationMs,
      startedAt: toIsoTimestamp(Date.now() - result.durationMs),
      finishedAt: toIsoTimestamp(Date.now())
    })
  } catch (error) {
    results.push({
      ...step,
      status: 'failed',
      durationMs: null,
      startedAt: null,
      finishedAt: toIsoTimestamp(Date.now())
    })
    failure = error
    break
  }
}

const executedCount = results.length
const skipped = stepsToRun.slice(executedCount)

process.stdout.write('\nGate execution summary:\n')
for (const result of results) {
  if (result.status === 'passed') {
    process.stdout.write(`  ✓ ${result.name} (${formatCommand(result)}) in ${result.durationMs}ms\n`)
  } else {
    process.stdout.write(`  ✗ ${result.name} (${formatCommand(result)})\n`)
  }
  if (result.evidenceFile) {
    process.stdout.write(`    evidence: ${result.evidenceFile}\n`)
  }
}

if (skipped.length > 0) {
  process.stdout.write('\nNot executed due to earlier failure:\n')
  for (const step of skipped) {
    process.stdout.write(`  • ${step.name} (${formatCommand(step)})\n`)
  }
}

if (failure) {
  const failedStep = results[results.length - 1] || null
  process.stderr.write(`\n❌ ${buildFailureMessage({ failureError: failure, failedStep })}\n`)
  process.exitCode = Number.isInteger(failure.exitCode) ? failure.exitCode : 1
} else {
  process.stdout.write('\n✅ Hard release gate passed.\n')
}

const summary = {
  schemaVersion: '1.1.0',
  generatedAt: toIsoTimestamp(Date.now()),
  nodeEnv: process.env.NODE_ENV || null,
  evidenceDir: defaultEvidenceDir,
  status: failure ? 'failed' : 'passed',
  startedAt: toIsoTimestamp(startedAt),
  finishedAt: toIsoTimestamp(Date.now()),
  failedStep: failure ? results[results.length - 1]?.name || null : null,
  steps: stepsToRun.map((step) => {
    const executed = results.find((result) => result.name === step.name)
    if (!executed) {
      return {
        name: step.name,
        command: formatCommand(step),
        evidenceFile: step.evidenceFile,
        status: 'skipped',
        durationMs: null,
        startedAt: null,
        finishedAt: null
      }
    }
    return {
      name: executed.name,
      command: formatCommand(executed),
      evidenceFile: step.evidenceFile,
      status: executed.status,
      durationMs: Number.isFinite(executed.durationMs) ? executed.durationMs : null,
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt
    }
  })
}

const defaultEvidenceFile = resolve(defaultEvidenceDir, 'validate-master-summary.json')
const evidenceFile = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_FILE || defaultEvidenceFile)
mkdirSync(dirname(evidenceFile), { recursive: true })
writeFileSync(evidenceFile, JSON.stringify(summary, null, 2))
process.stdout.write(`\nRelease evidence summary written to ${evidenceFile}\n`)
process.stdout.write(`RELEASE_EVIDENCE_JSON=${evidenceFile}\n`)

// Ensure aggregate validation terminates deterministically in packed/unpacked environments.
process.exit(process.exitCode ?? 0)
