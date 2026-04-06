import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runCommandProcess } from './runner-lifecycle.mjs'

const defaultEvidenceDir = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_DIR || 'artifacts/release-evidence')

const gateSteps = [
  { name: 'Static syntax checks', command: 'npm', args: ['run', 'check:syntax'], evidenceFile: null },
  { name: 'Conflict marker guard', command: 'npm', args: ['run', 'check:conflicts'], evidenceFile: null },
  {
    name: 'API contract tests',
    command: 'npm',
    args: ['run', 'test:contract'],
    evidenceFile: resolve(defaultEvidenceDir, 'api-contract-summary.json')
  },
  { name: 'Negative-path RBAC checks', command: 'node', args: ['scripts/integration-rbac.mjs'], evidenceFile: null },
  {
    name: 'Negative-path tenancy checks',
    command: 'node',
    args: ['scripts/integration-tenancy.mjs'],
    evidenceFile: null
  },
  {
    name: 'Integration suites',
    command: 'npm',
    args: ['run', 'test:integration'],
    evidenceFile: resolve(defaultEvidenceDir, 'integration-summary.json')
  },
  {
    name: 'Migration order checks',
    command: 'npm',
    args: ['run', 'check:migrations'],
    evidenceFile: resolve(defaultEvidenceDir, 'migration-summary.json')
  },
  {
    name: 'Smoke test',
    command: 'npm',
    args: ['run', 'test:smoke'],
    evidenceFile: resolve(defaultEvidenceDir, 'smoke-summary.json')
  },
  {
    name: 'Security checks',
    command: 'npm',
    args: ['run', 'test:security'],
    evidenceFile: resolve(defaultEvidenceDir, 'security-summary.json')
  },
  { name: 'Merge/main parity check', command: 'npm', args: ['run', 'check:merge-main'], evidenceFile: null }
]


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
  if (step.evidenceFile && step.name === 'Security checks') env.RELEASE_EVIDENCE_SECURITY_FILE = step.evidenceFile
  return env
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
      env: envForStep(step)
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
  process.stderr.write(`\n❌ ${failure.message}\n`)
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
