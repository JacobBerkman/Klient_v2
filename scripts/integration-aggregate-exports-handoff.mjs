import { runCommandProcess } from './runner-lifecycle.mjs'

const suites = ['integration-templates.mjs', 'integration-exports.mjs']
const timeoutMs = 180_000

try {
  await runCommandProcess({
    command: process.execPath,
    args: ['scripts/master-integration.mjs'],
    label: 'aggregate-exports-handoff-regression',
    invariant:
      'Aggregate integration runner must hand off cleanly from template setup into exports without server lifecycle connection failures.',
    env: {
      ...process.env,
      INTEGRATION_SUITES: suites.join(',')
    },
    stdio: 'inherit',
    timeoutMs
  })
} catch (error) {
  const baseMessage = String(error?.message || error)
  throw new Error(
    `aggregate-exports-handoff-regression failed (suites=${suites.join(' -> ')}, timeoutMs=${timeoutMs}): ${baseMessage}`
  )
}

console.log(JSON.stringify({ suite: 'integration-aggregate-exports-handoff', executed: suites }, null, 2))
