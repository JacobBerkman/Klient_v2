import { runCommandProcess } from './runner-lifecycle.mjs'

const suites = ['integration-templates.mjs', 'integration-exports.mjs']

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
  timeoutMs: 180_000
})

console.log(JSON.stringify({ suite: 'integration-aggregate-exports-handoff', executed: suites }, null, 2))
