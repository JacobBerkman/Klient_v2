import { spawn } from 'node:child_process'

const securitySuites = ['apps/api/src/test/auth-policy.test.mjs', 'apps/api/src/test/pii-crypto.test.mjs']

const child = spawn(process.execPath, ['--test', ...securitySuites], {
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Security checks terminated by signal ${signal}.\n`)
    process.exit(1)
    return
  }
  process.exit(code ?? 1)
})
