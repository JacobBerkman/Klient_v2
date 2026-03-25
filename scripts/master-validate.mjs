import { spawn } from 'node:child_process'

const gateSteps = [
  { name: 'Static syntax checks', command: 'npm', args: ['run', 'check:syntax'] },
  { name: 'API contract tests', command: 'npm', args: ['run', 'test:contract'] },
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

const results = []
let failure = null

for (let index = 0; index < gateSteps.length; index += 1) {
  const step = gateSteps[index]
  try {
    // eslint-disable-next-line no-await-in-loop
    const result = await runStep(step, index, gateSteps.length)
    results.push({ ...step, status: 'passed', durationMs: result.durationMs })
  } catch (error) {
    results.push({ ...step, status: 'failed' })
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
