import { createEvidenceRecorder } from './release-evidence.mjs'
import { spawn, spawnSync } from 'node:child_process'

const securitySuites = ['apps/api/src/test/auth-policy.test.mjs', 'apps/api/src/test/pii-crypto.test.mjs']

const evidence = createEvidenceRecorder({
  gate: 'security',
  defaultFile: 'security-summary.json',
  envVarName: 'RELEASE_EVIDENCE_SECURITY_FILE',
  command: 'npm run test:security',
  metadata: { suites: securitySuites, assertions: ['production config enables the API rate limiter'] }
})

// Assertion: a production runtime config must enable the API rate limiter
// (RATE_LIMIT_ENABLED defaults to true outside NODE_ENV=test). Evaluated in a
// child process so the production env shaping cannot leak into the suites.
const rateLimiterAssertion = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    [
      "import { pathToFileURL } from 'node:url'",
      "const { runtime } = await import(pathToFileURL('apps/api/src/runtime.mjs').href)",
      'if (runtime.rateLimit.enabled !== true) {',
      "  console.error('Production runtime config must enable the API rate limiter (RATE_LIMIT_ENABLED).')",
      '  process.exit(1)',
      '}'
    ].join('\n')
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_SECRET: 'security-checks-rate-limit-assertion-secret',
      AUTH_PROVIDER: 'local',
      RATE_LIMIT_ENABLED: '',
      ENABLE_TEST_CSRF_BYPASS: '',
      UNSAFE_ALLOW_WEAK_APP_SECRET: '',
      ALLOW_DEV_FALLBACK_APP_SECRET: ''
    }
  }
)
if ((rateLimiterAssertion.status ?? 1) !== 0) {
  evidence.finalize({
    status: 'failed',
    error: new Error('production rate limiter assertion failed'),
    details: { assertion: 'production config enables the API rate limiter' }
  })
  process.stderr.write('Security checks failed: production config must enable the API rate limiter.\n')
  process.exit(1)
}

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
    process.stderr.write(`Security checks failed with exit code ${code ?? 1}. Suites: ${securitySuites.join(', ')}\n`)
  } else {
    evidence.finalize({ status: 'passed', details: { suites: securitySuites } })
  }
  process.exit(code ?? 1)
})
