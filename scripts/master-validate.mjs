import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const gateSteps = [
  { name: 'Static syntax checks', command: 'npm', args: ['run', 'check:syntax'] },
  { name: 'API contract tests', command: 'npm', args: ['run', 'test:contract'] },
  { name: 'Negative-path RBAC checks', command: 'node', args: ['scripts/integration-rbac.mjs'] },
  { name: 'Negative-path tenancy checks', command: 'node', args: ['scripts/integration-tenancy.mjs'] },
  { name: 'Integration suites', command: 'npm', args: ['run', 'test:integration'] },
  { name: 'Migration order checks', command: 'npm', args: ['run', 'check:migrations'] },
  { name: 'Smoke test', command: 'npm', args: ['run', 'test:smoke'] },
  { name: 'Security checks', command: 'npm', args: ['run', 'test:security'] },
  { name: 'Merge/main parity check', command: 'npm', args: ['run', 'check:merge-main'] }
]

function formatCommand(step) {
  return `${step.command} ${step.args.join(' ')}`
}

function runStep(step, index, total) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    process.stdout.write(`\n▶ [${index + 1}/${total}] ${step.name}\n$ ${formatCommand(step)}\n\n`)

    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env
    })

    child.on('error', (error) => {
      reject(
        new Error(`Failed to launch step "${step.name}" (${formatCommand(step)}): ${error.message}`)
      )
    })

    child.on('exit', (code, signal) => {
      const durationMs = Date.now() - start
      if (signal) {
        reject(new Error(`Step "${step.name}" terminated by signal ${signal} after ${durationMs}ms`))
        return
      }
      if (code !== 0) {
        const error = new Error(
          `Step "${step.name}" failed with exit code ${code} after ${durationMs}ms (${formatCommand(step)})`
        )
        error.exitCode = code
        reject(error)
        return
      }
      resolve({ durationMs })
    })
  })
}

function toIsoTimestamp(dateValue) {
  return new Date(dateValue).toISOString()
}

const results = []
let failure = null
const startedAt = Date.now()

for (let index = 0; index < gateSteps.length; index += 1) {
  const step = gateSteps[index]
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await runStep(step, index, gateSteps.length)
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
const skipped = gateSteps.slice(executedCount)

process.stdout.write('\nGate execution summary:\n')
for (const result of results) {
  if (result.status === 'passed') {
    process.stdout.write(`  ✓ ${result.name} (${formatCommand(result)}) in ${result.durationMs}ms\n`)
  } else {
    process.stdout.write(`  ✗ ${result.name} (${formatCommand(result)})\n`)
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
  schemaVersion: '1.0.0',
  generatedAt: toIsoTimestamp(Date.now()),
  nodeEnv: process.env.NODE_ENV || null,
  status: failure ? 'failed' : 'passed',
  startedAt: toIsoTimestamp(startedAt),
  finishedAt: toIsoTimestamp(Date.now()),
  failedStep: failure ? results[results.length - 1]?.name || null : null,
  steps: gateSteps.map((step) => {
    const executed = results.find((result) => result.name === step.name)
    if (!executed) {
      return {
        name: step.name,
        command: formatCommand(step),
        status: 'skipped',
        durationMs: null,
        startedAt: null,
        finishedAt: null
      }
    }
    return {
      name: executed.name,
      command: formatCommand(executed),
      status: executed.status,
      durationMs: Number.isFinite(executed.durationMs) ? executed.durationMs : null,
      startedAt: executed.startedAt,
      finishedAt: executed.finishedAt
    }
  })
}

const defaultEvidenceFile = 'artifacts/release-evidence/validate-master-summary.json'
const evidenceFile = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_FILE || defaultEvidenceFile)
mkdirSync(dirname(evidenceFile), { recursive: true })
writeFileSync(evidenceFile, JSON.stringify(summary, null, 2))
process.stdout.write(`\nRelease evidence summary written to ${evidenceFile}\n`)
process.stdout.write(`RELEASE_EVIDENCE_JSON=${evidenceFile}\n`)
