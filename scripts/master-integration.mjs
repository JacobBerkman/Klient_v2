import { access } from 'node:fs/promises'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { runSuite } from './runner-lifecycle.mjs'

const integrationSuites = [
  {
    script: 'integration-tenancy.mjs',
    invariant: 'Tenant isolation blocks cross-tenant read/write access and cross-tenant audit visibility.'
  },
  {
    script: 'integration-rbac.mjs',
    invariant: 'Direct RBAC checks enforce readonly/advisor restrictions for privileged routes.'
  },
  {
    script: 'integration-rbac-matrix.mjs',
    invariant: 'Policy matrix allow/deny behavior is enforced for every role/route guard pairing.'
  },
  {
    script: 'integration-templates.mjs',
    invariant: 'Template lifecycle remains consistent across create/update/publish pathways.'
  },
  {
    script: 'integration-exports.mjs',
    invariant: 'Export workflows maintain expected lifecycle transitions and retry behavior.'
  },
  {
    script: 'integration-portal-lifecycle.mjs',
    invariant: 'Portal access lifecycle enforces token, submission, and upload requirements.'
  },
  {
    script: 'integration-submission-repeatable-items.mjs',
    invariant: 'Repeatable submission data remains stable through create/update flows.'
  },
  {
    script: 'integration-analytics.mjs',
    invariant: 'Analytics endpoints remain queryable with authenticated data-scoped responses.'
  },
  {
    script: 'integration-e2e-workflows.mjs',
    invariant:
      'Critical end-to-end workflows (bootstrap/login, advisor draft conflicts, template-to-submission, portal draft+submit) remain deterministic.'
  },
  {
    script: 'integration-csrf.mjs',
    invariant: 'CSRF protection is enforced for protected methods while exempt routes remain functional.'
  },
  {
    script: 'integration-audit.mjs',
    invariant: 'Required canonical audit events and payload fields are emitted for sensitive actions.'
  }
]

const evidence = createEvidenceRecorder({
  gate: 'integration',
  defaultFile: 'integration-summary.json',
  envVarName: 'RELEASE_EVIDENCE_INTEGRATION_FILE',
  command: 'npm run test:integration'
})

function resolveSuitesFromEnv() {
  const rawFilter = process.env.INTEGRATION_SUITES
  if (!rawFilter) return integrationSuites

  const requestedScripts = rawFilter
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (requestedScripts.length === 0) return integrationSuites

  const selected = integrationSuites.filter((suite) => requestedScripts.includes(suite.script))
  if (selected.length === 0) {
    throw new Error(`INTEGRATION_SUITES did not match any suite script names: ${rawFilter}`)
  }
  return selected
}

async function ensureScriptExists(script) {
  await access(new URL(`./${script}`, import.meta.url))
}

async function main() {
  const suitesToRun = resolveSuitesFromEnv()
  console.log('Starting integration suite in deterministic order with explicit invariant coverage.')

  for (const suite of suitesToRun) {
    await ensureScriptExists(suite.script)
  }

  const executed = []

  for (let index = 0; index < suitesToRun.length; index += 1) {
    const suite = suitesToRun[index]
    const result = await runSuite(suite, index, suitesToRun.length)
    executed.push({ script: suite.script, durationMs: result.durationMs })
  }

  const totalDurationMs = executed.reduce((sum, run) => sum + run.durationMs, 0)
  evidence.finalize({
    status: 'passed',
    details: { totalDurationMs, executed }
  })
  console.log('\n✅ All integration scripts passed.')
  console.log(`Executed ${executed.length} suites in ${totalDurationMs}ms.`)
}

main().catch((error) => {
  evidence.finalize({ status: 'failed', error })
  console.error(`\n❌ Integration suite failed: ${error.message}`)
  process.exit(1)
})
