import { access } from 'node:fs/promises'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { runSuite } from './runner-lifecycle.mjs'

const integrationSuiteDefinitions = {
  'integration-tenancy.mjs': {
    invariant: 'Tenant isolation blocks cross-tenant read/write access and cross-tenant audit visibility.'
  },
  'integration-rbac.mjs': { invariant: 'Direct RBAC checks enforce readonly/advisor restrictions for privileged routes.' },
  'integration-rbac-matrix.mjs': {
    invariant: 'Policy matrix allow/deny behavior is enforced for every role/route guard pairing.'
  },
  'integration-templates.mjs': { invariant: 'Template lifecycle remains consistent across create/update/publish pathways.' },
  'integration-exports.mjs': { invariant: 'Export workflows maintain expected lifecycle transitions and retry behavior.' },
  'integration-portal-lifecycle.mjs': { invariant: 'Portal access lifecycle enforces token, submission, and upload requirements.' },
  'integration-submission-repeatable-items.mjs': {
    invariant: 'Repeatable submission data remains stable through create/update flows.'
  },
  'integration-analytics.mjs': { invariant: 'Analytics endpoints remain queryable with authenticated data-scoped responses.' },
  'integration-e2e-workflows.mjs': {
    invariant:
      'Release-blocking end-to-end workflow (bootstrap/login, inline profile edit, board move, template/submission, worker-driven export completion, portal draft+submit) remains deterministic.'
  },
  'integration-csrf.mjs': { invariant: 'CSRF protection is enforced for protected methods while exempt routes remain functional.' },
  'integration-audit.mjs': {
    invariant: 'Required canonical audit events and payload fields are emitted for sensitive actions.'
  }
}

const INTEGRATION_SUITE_ORDER = Object.freeze([
  'integration-tenancy.mjs',
  'integration-rbac.mjs',
  'integration-rbac-matrix.mjs',
  'integration-templates.mjs',
  'integration-exports.mjs',
  'integration-portal-lifecycle.mjs',
  'integration-submission-repeatable-items.mjs',
  'integration-analytics.mjs',
  'integration-e2e-workflows.mjs',
  'integration-csrf.mjs',
  'integration-audit.mjs'
])

function buildOrderedSuites(order, definitions) {
  return Object.freeze(
    order.map((script) => {
      const suite = definitions[script]
      if (!suite) throw new Error(`Missing integration suite definition: ${script}`)
      return Object.freeze({ script, ...suite })
    })
  )
}

function assertSuiteOrderInvariant(suites, expectedOrder) {
  const observed = suites.map((suite) => suite.script)
  if (observed.length !== expectedOrder.length) {
    throw new Error(`integration suite order length drifted. expected=${expectedOrder.length} actual=${observed.length}`)
  }
  for (let index = 0; index < expectedOrder.length; index += 1) {
    if (observed[index] !== expectedOrder[index]) {
      throw new Error(
        `integration suite sequence changed at index ${index}. expected="${expectedOrder[index]}" actual="${observed[index]}"`
      )
    }
  }
}

const integrationSuites = buildOrderedSuites(INTEGRATION_SUITE_ORDER, integrationSuiteDefinitions)
assertSuiteOrderInvariant(integrationSuites, INTEGRATION_SUITE_ORDER)

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

  process.exitCode = 0
}

main().catch((error) => {
  evidence.finalize({ status: 'failed', error })
  console.error(`\n❌ Integration suite failed: ${error.message}`)
  process.exitCode = 1
})
