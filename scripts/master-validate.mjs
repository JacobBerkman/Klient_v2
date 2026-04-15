import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runCommandProcess } from './runner-lifecycle.mjs'
import { resolvePlaywrightLinkageEnv } from './playwright-provisioning.mjs'

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
  'Canonical release flow': {
    command: 'npm',
    args: ['run', 'test:release-flow'],
    evidenceFile: resolve(defaultEvidenceDir, 'release-flow-summary.json')
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
  'Canonical release flow',
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
  if (step.evidenceFile && step.name === 'Canonical release flow') {
    env.RELEASE_EVIDENCE_RELEASE_FLOW_FILE = step.evidenceFile
  }
  if (step.evidenceFile && step.name === 'E2E browser checks') {
    const strictMode = resolveValidateMasterE2EStrictMode({
      strictOverride: process.env.RELEASE_E2E_STRICT_MODE,
      allowFallbackOverride: process.env.RELEASE_E2E_ALLOW_FALLBACK,
      gitCheckout: isGitCheckout(),
      unpackedArtifactIntent: parseBooleanSignal(process.env.RELEASE_EVIDENCE_UNPACKED_ARTIFACT) === true
    })
    if (strictMode.warningLine) {
      process.stdout.write(`\n${strictMode.warningLine}\n`)
    }
    env.RELEASE_EVIDENCE_E2E_FILE = step.evidenceFile
    env.RELEASE_E2E_STRICT_MODE = strictMode.strictMode ? '1' : '0'
    env.RELEASE_E2E_ALLOW_FALLBACK = strictMode.allowFallback ? '1' : '0'
    Object.assign(
      env,
      resolvePlaywrightLinkageEnv(
        {
          ...env,
          PLAYWRIGHT_JSON_REPORT: resolve(defaultEvidenceDir, 'playwright-report.json')
        },
        { evidenceDir: defaultEvidenceDir }
      )
    )
  }
  if (step.evidenceFile && step.name === 'Security checks') env.RELEASE_EVIDENCE_SECURITY_FILE = step.evidenceFile
  return env
}

function parseBooleanSignal(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function isReleaseRefEnvironment(env) {
  const githubRef = String(env.GITHUB_REF || '').trim()
  const githubRefName = String(env.GITHUB_REF_NAME || '').trim()
  const gitlabTag = String(env.CI_COMMIT_TAG || '').trim()
  const gitlabRefName = String(env.CI_COMMIT_REF_NAME || '').trim()

  if (githubRef.startsWith('refs/tags/')) return true
  if (githubRef.startsWith('refs/heads/release/') || githubRef.startsWith('refs/heads/release-')) return true
  if (githubRefName.startsWith('release/') || githubRefName.startsWith('release-')) return true
  if (gitlabTag) return true
  if (gitlabRefName.startsWith('release/') || gitlabRefName.startsWith('release-')) return true
  return false
}

export function resolveValidateMasterE2EStrictMode({
  strictOverride,
  allowFallbackOverride,
  gitCheckout,
  unpackedArtifactIntent = false
}) {
  const approvalSignal = parseBooleanSignal(process.env.RELEASE_APPROVAL_MODE)
  const ciSignal = parseBooleanSignal(process.env.CI)
  const isApprovalMode = approvalSignal === true || ciSignal === true || isReleaseRefEnvironment(process.env)
  if (isApprovalMode) {
    return {
      mode: 'release_approval',
      strictMode: true,
      allowFallback: false,
      warningLine: null
    }
  }

  const strictSignal = parseBooleanSignal(strictOverride)
  const fallbackSignal = parseBooleanSignal(allowFallbackOverride)
  const hasDiagnosticOverride = strictSignal !== null || fallbackSignal !== null
  if (unpackedArtifactIntent) {
    return {
      mode: 'unpacked_artifact',
      strictMode: true,
      allowFallback: false,
      warningLine: null
    }
  }

  if (!gitCheckout && !hasDiagnosticOverride) {
    return {
      mode: 'diagnostic_local',
      strictMode: true,
      allowFallback: false,
      warningLine: null
    }
  }

  if (strictSignal !== null || fallbackSignal !== null) {
    const strictMode = strictSignal ?? !fallbackSignal
    return {
      mode: 'diagnostic_local',
      strictMode,
      allowFallback: fallbackSignal ?? !strictMode,
      warningLine:
        !strictMode && (fallbackSignal ?? !strictMode)
          ? '⚠️ NON-APPROVING DIAGNOSTIC MODE: E2E fallback is enabled and cannot be used for release approval.'
          : null
    }
  }

  if (!gitCheckout) {
    return {
      mode: 'diagnostic_local',
      strictMode: true,
      allowFallback: false,
      warningLine: null
    }
  }

  return {
    mode: 'diagnostic_local',
    strictMode: true,
    allowFallback: false,
    warningLine: null
  }
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
const defaultEvidenceFile = resolve(defaultEvidenceDir, 'validate-master-summary.json')
const evidenceFile = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_FILE || defaultEvidenceFile)
let finalSummary = null
let activeStep = null
let activeStepStartedAt = null
let interruptedActiveStepSnapshot = null

function buildSummary({ failureError = null, failedStepName = null }) {
  const derivedFailedStep = failedStepName || results[results.length - 1]?.name || null
  return {
    schemaVersion: '1.1.0',
    generatedAt: toIsoTimestamp(Date.now()),
    nodeEnv: process.env.NODE_ENV || null,
    evidenceDir: defaultEvidenceDir,
    status: failureError ? 'failed' : 'passed',
    startedAt: toIsoTimestamp(startedAt),
    finishedAt: toIsoTimestamp(Date.now()),
    durationMs: Date.now() - startedAt,
    failedStep: failureError ? derivedFailedStep : null,
    error: failureError ? { message: String(failureError?.message || failureError) } : null,
    steps: stepsToRun.map((step) => {
      const executed = results.find((result) => result.name === step.name)
      if (!executed) {
        if (failureError && interruptedActiveStepSnapshot?.name === step.name) {
          return {
            name: step.name,
            command: formatCommand(step),
            evidenceFile: step.evidenceFile,
            status: 'failed',
            durationMs: interruptedActiveStepSnapshot.durationMs,
            startedAt: interruptedActiveStepSnapshot.startedAt,
            finishedAt: interruptedActiveStepSnapshot.finishedAt
          }
        }
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
}

function persistSummary(summary) {
  mkdirSync(dirname(evidenceFile), { recursive: true })
  writeFileSync(evidenceFile, JSON.stringify(summary, null, 2))
}

const stepsToRun = resolveGateStepsFromEnv()
function clearStaleEvidenceFiles() {
  const staleCandidates = new Set([evidenceFile])
  for (const step of gateSteps) {
    if (step.evidenceFile) staleCandidates.add(step.evidenceFile)
  }

  const linkage = resolvePlaywrightLinkageEnv(
    {
      ...process.env,
      RELEASE_EVIDENCE_DIR: defaultEvidenceDir
    },
    { evidenceDir: defaultEvidenceDir }
  )
  staleCandidates.add(linkage.RELEASE_E2E_PROVISIONING_ARTIFACT)
  staleCandidates.add(linkage.RELEASE_E2E_PLAYWRIGHT_REPORT)

  for (const candidate of staleCandidates) {
    rmSync(candidate, { force: true })
  }
}

clearStaleEvidenceFiles()
persistSummary({
  schemaVersion: '1.1.0',
  generatedAt: toIsoTimestamp(Date.now()),
  nodeEnv: process.env.NODE_ENV || null,
  evidenceDir: defaultEvidenceDir,
  status: 'running',
  startedAt: toIsoTimestamp(startedAt),
  finishedAt: null,
  durationMs: null,
  failedStep: null,
  error: null,
  steps: stepsToRun.map((step) => ({
    name: step.name,
    command: formatCommand(step),
    evidenceFile: step.evidenceFile,
    status: 'pending',
    durationMs: null,
    startedAt: null,
    finishedAt: null
  }))
})

function finalizeGateSummary(failureError = null) {
  if (finalSummary) return finalSummary
  if (failureError && activeStep && !interruptedActiveStepSnapshot) {
    const interruptedAt = Date.now()
    interruptedActiveStepSnapshot = {
      name: activeStep.name,
      startedAt: toIsoTimestamp(activeStepStartedAt || startedAt),
      finishedAt: toIsoTimestamp(interruptedAt),
      durationMs: interruptedAt - (activeStepStartedAt || startedAt)
    }
  }
  finalSummary = buildSummary({
    failureError,
    failedStepName: activeStep?.name || null
  })
  persistSummary(finalSummary)
  return finalSummary
}

const failOnSignal = (signal) => {
  const interruption = new Error(`validate:master interrupted by ${signal}`)
  if (!failure) {
    failure = interruption
  }
  finalizeGateSummary(failure)
  process.exit(1)
}

process.on('SIGINT', () => failOnSignal('SIGINT'))
process.on('SIGTERM', () => failOnSignal('SIGTERM'))
process.on('uncaughtException', (error) => {
  if (!failure) failure = error
  finalizeGateSummary(failure)
})
process.on('unhandledRejection', (reason) => {
  if (!failure) {
    failure = reason instanceof Error ? reason : new Error(String(reason))
  }
  finalizeGateSummary(failure)
})
process.on('beforeExit', () => {
  if (!finalSummary) {
    finalizeGateSummary(failure || new Error('validate:master exited before finalizing evidence'))
  }
})
process.on('exit', (code) => {
  if (!finalSummary) {
    const exitFailure =
      failure ||
      (code === 0 ? new Error('validate:master exited before finalizing evidence') : new Error(`validate:master exited with code ${code}`))
    finalizeGateSummary(exitFailure)
  }
})

for (let index = 0; index < stepsToRun.length; index += 1) {
  const step = stepsToRun[index]
  activeStep = step
  activeStepStartedAt = Date.now()
  const stepStartedAt = Date.now()
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await runStep(step, index, stepsToRun.length)
    const finishedAt = Date.now()
    results.push({
      ...step,
      status: 'passed',
      durationMs: result.durationMs,
      startedAt: toIsoTimestamp(stepStartedAt),
      finishedAt: toIsoTimestamp(finishedAt)
    })
  } catch (error) {
    const failedAt = Date.now()
    results.push({
      ...step,
      status: 'failed',
      durationMs: failedAt - stepStartedAt,
      startedAt: toIsoTimestamp(stepStartedAt),
      finishedAt: toIsoTimestamp(failedAt)
    })
    failure = error
    break
  } finally {
    activeStep = null
    activeStepStartedAt = null
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

const summary = finalizeGateSummary(failure)
process.stdout.write(`\nRelease evidence summary written to ${evidenceFile}\n`)
process.stdout.write(`RELEASE_EVIDENCE_JSON=${evidenceFile}\n`)

// Ensure aggregate validation terminates deterministically in packed/unpacked environments.
process.exit(process.exitCode ?? 0)
