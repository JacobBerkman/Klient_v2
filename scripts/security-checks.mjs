import { createEvidenceRecorder } from './release-evidence.mjs'
import { spawn } from 'node:child_process'

const securitySuites = ['apps/api/src/test/auth-policy.test.mjs', 'apps/api/src/test/pii-crypto.test.mjs']

const evidence = createEvidenceRecorder({
  gate: 'security',
  defaultFile: 'security-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SECURITY_FILE',
  command: 'npm run test:security',
  metadata: { suites: securitySuites }
})

const child = spawn(process.execPath, ['--test', ...securitySuites], {
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code, signal) => {
  if (signal) {
    evidence.finalize({ status: 'failed', error: new Error(`terminated by signal ${signal}`) })
    process.stderr.write(`Security checks terminated by signal ${signal}.\n`)
    process.exit(1)
    return
  }
  if ((code ?? 1) !== 0) {
    evidence.finalize({
      status: 'failed',
      error: new Error(`exit code ${code ?? 1}`),
      details: { suites: securitySuites }
    })
    process.stderr.write(
      `Security checks failed with exit code ${code ?? 1}. Suites: ${securitySuites.join(', ')}\n`
    )
  } else {
    evidence.finalize({ status: 'passed', details: { suites: securitySuites } })
  }
  process.exit(code ?? 1)
})
