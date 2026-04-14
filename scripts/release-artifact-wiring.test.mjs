import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function extractSummaryNames(content) {
  return [...content.matchAll(/'([a-z0-9-]+-summary\.json)'/g)].map((match) => match[1])
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

test('preflight evidence summary filenames stay aligned across gate orchestration and evidence validators', () => {
  const masterValidate = read('scripts/master-validate.mjs')
  const validateReleaseEvidence = read('scripts/validate-release-evidence.mjs')
  const packageEvidence = read('scripts/package-release-evidence.mjs')

  const gateSummaryFiles = sortedUnique(
    [...masterValidate.matchAll(/evidenceFile:\s*resolve\(defaultEvidenceDir,\s*'([^']+)'\)/g)].map((match) => match[1])
  )

  const validateRequiredSummaryFiles = sortedUnique(extractSummaryNames(validateReleaseEvidence))
  const packagePreflightSummaryFiles = sortedUnique(extractSummaryNames(packageEvidence))

  const canonicalGateSummaries = [
    'api-contract-summary.json',
    'e2e-summary.json',
    'integration-summary.json',
    'migration-summary.json',
    'security-summary.json',
    'smoke-summary.json'
  ]

  assert.deepEqual(gateSummaryFiles, canonicalGateSummaries)
  assert.equal(validateRequiredSummaryFiles.filter((name) => name === 'e2e-summary.json').length, 1)

  for (const summaryName of canonicalGateSummaries) {
    assert(validateRequiredSummaryFiles.includes(summaryName), `validate-release-evidence missing ${summaryName}`)
    assert(packagePreflightSummaryFiles.includes(summaryName), `package-release-evidence missing ${summaryName}`)
  }
})

test('validate master evidence env var wiring remains explicit for every evidence-producing gate', () => {
  const masterValidate = read('scripts/master-validate.mjs')

  const expectedMappings = [
    ['API contract tests', 'RELEASE_EVIDENCE_CONTRACT_FILE'],
    ['Integration suites', 'RELEASE_EVIDENCE_INTEGRATION_FILE'],
    ['Migration order checks', 'RELEASE_EVIDENCE_MIGRATION_FILE'],
    ['Smoke test', 'RELEASE_EVIDENCE_SMOKE_FILE'],
    ['E2E browser checks', 'RELEASE_EVIDENCE_E2E_FILE'],
    ['Security checks', 'RELEASE_EVIDENCE_SECURITY_FILE']
  ]

  const baseGateStepsBlock = masterValidate.match(/const baseGateStepDefinitions = \{([\s\S]*?)\n\}/)?.[1] || ''
  const evidenceProducingStepLabels = sortedUnique(
    [...baseGateStepsBlock.matchAll(/'([^']+)':\s*\{[^}]*evidenceFile:\s*resolve\(defaultEvidenceDir,\s*'[^']+'\)/g)].map((match) => match[1])
  )
  const expectedMappingLabels = sortedUnique(expectedMappings.map(([stepLabel]) => stepLabel))
  assert.deepEqual(
    expectedMappingLabels,
    evidenceProducingStepLabels,
    'expectedMappings must cover all evidence-producing baseGateSteps labels'
  )

  for (const [stepLabel, envVarName] of expectedMappings) {
    const escapedLabel = stepLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedVar = envVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`step\\.name === '${escapedLabel}'\\)[\\s\\S]*?env\\.${escapedVar}`)
    assert(pattern.test(masterValidate), `Missing ${stepLabel} -> ${envVarName} wiring in envForStep`)
  }
})

test('validate:master keeps syntax checks before conflict marker guard', () => {
  const masterValidate = read('scripts/master-validate.mjs')
  const syntaxIndex = masterValidate.indexOf("'Static syntax checks'")
  const conflictGuardIndex = masterValidate.indexOf("'Conflict marker guard'")

  assert.notEqual(syntaxIndex, -1, 'Expected Static syntax checks gate step to exist')
  assert.notEqual(conflictGuardIndex, -1, 'Expected Conflict marker guard gate step to exist')
  assert.ok(syntaxIndex < conflictGuardIndex, 'Static syntax checks must execute before conflict marker guard')
})

test('validate:master base gate order is locked as a deterministic invariant', () => {
  const masterValidate = read('scripts/master-validate.mjs')
  const orderMatch = masterValidate.match(/const BASE_GATE_ORDER = Object\.freeze\(\[([\s\S]*?)\]\)/)
  assert.ok(orderMatch, 'BASE_GATE_ORDER must be declared')

  const orderItems = [...orderMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(orderItems, [
    'Static syntax checks',
    'Conflict marker guard',
    'API contract tests',
    'Negative-path RBAC checks',
    'Negative-path tenancy checks',
    'Integration suites',
    'Aggregate handoff regression',
    'Migration order checks',
    'Smoke test',
    'UI contract checks',
    'E2E browser checks',
    'Security checks'
  ])
  assert.match(masterValidate, /assertOrderedInvariant\(baseGateSteps, BASE_GATE_ORDER, 'baseGateSteps'\)/)
  assert.match(masterValidate, /assertOrderedInvariant\(\s*gateSteps,/)
})

test('master-integration suite order is locked as a deterministic invariant', () => {
  const masterIntegration = read('scripts/master-integration.mjs')
  const orderMatch = masterIntegration.match(/const INTEGRATION_SUITE_ORDER = Object\.freeze\(\[([\s\S]*?)\]\)/)
  assert.ok(orderMatch, 'INTEGRATION_SUITE_ORDER must be declared')

  const orderItems = [...orderMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(orderItems, [
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
  assert.match(masterIntegration, /assertSuiteOrderInvariant\(integrationSuites, INTEGRATION_SUITE_ORDER\)/)
})

test('strict-mode E2E semantics are pinned in workflow hard/e2e release gates', () => {
  const workflow = read('.github/workflows/smoke.yml')
  assert.match(workflow, /RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0 E2E_GREP='@release-blocking' npm run test:e2e/)
  assert.match(workflow, /RELEASE_E2E_ALLOW_FALLBACK=0 RELEASE_E2E_STRICT_MODE=1 npm run validate:master/)
  assert.match(workflow, /- strict mode: RELEASE_E2E_STRICT_MODE=1/)
  assert.match(workflow, /- fallback: RELEASE_E2E_ALLOW_FALLBACK=0/)
})

test('critical release gate scripts are present for artifact/evidence wiring', () => {
  const requiredFiles = [
    'scripts/master-validate.mjs',
    'scripts/master-integration.mjs',
    'scripts/runner-lifecycle.mjs',
    'scripts/validate-release-evidence.mjs',
    'scripts/package-release-evidence.mjs'
  ]

  for (const file of requiredFiles) {
    assert.ok(existsSync(resolve(repoRoot, file)), `required release gate file missing: ${file}`)
  }
})

test('E2E evidence wiring includes Playwright report and provisioning linkage metadata', () => {
  const e2eScript = read('scripts/e2e-test.mjs')
  const releaseValidator = read('scripts/validate-release-evidence.mjs')

  assert.match(e2eScript, /function resolveEvidenceLinkageFromRuntime\(env = process\.env, reportPath = ''\)/)
  assert.match(e2eScript, /playwrightEvidenceLinkage: resolveEvidenceLinkageFromRuntime\(env, reportPath\)/)
  assert.match(e2eScript, /RELEASE_E2E_PROVISIONING_ARTIFACT/)
  assert.match(e2eScript, /RELEASE_E2E_PROVISIONING_VERSION/)

  assert.match(releaseValidator, /details\.artifacts\.playwrightEvidenceLinkage/)
  assert.match(releaseValidator, /provisioningArtifactPath/)
  assert.match(releaseValidator, /Strict browser evidence requires details\.artifacts\.playwrightEvidenceLinkage\.provisioningArtifactPath/)
})
