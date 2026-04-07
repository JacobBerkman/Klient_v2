import { createEvidenceRecorder } from './release-evidence.mjs'
import { spawn } from 'node:child_process'

const e2eSuites = ['apps/web/public/ui-contract.test.mjs']

const evidence = createEvidenceRecorder({
  gate: 'e2e',
  defaultFile: 'e2e-summary.json',
  envVarName: 'RELEASE_EVIDENCE_E2E_FILE',
  command: 'npm run test:e2e',
  metadata: { suites: e2eSuites }
})

const child = spawn(process.execPath, ['--test', ...e2eSuites], {
  stdio: 'inherit',
  env: process.env
})

child.on('exit', (code, signal) => {
  if (signal) {
    evidence.finalize({ status: 'failed', error: new Error(`terminated by signal ${signal}`) })
    process.stderr.write(`E2E checks terminated by signal ${signal}.\n`)
    process.exit(1)
    return
  }

  if ((code ?? 1) !== 0) {
    evidence.finalize({
      status: 'failed',
      error: new Error(`exit code ${code ?? 1}`),
      details: { suites: e2eSuites }
    })
    process.stderr.write(`E2E checks failed with exit code ${code ?? 1}. Suites: ${e2eSuites.join(', ')}\n`)
  } else {
    evidence.finalize({ status: 'passed', details: { suites: e2eSuites } })
  }

  process.exit(code ?? 1)
})
