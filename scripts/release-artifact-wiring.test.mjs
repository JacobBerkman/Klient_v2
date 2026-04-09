import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
    ['E2E checks', 'RELEASE_EVIDENCE_E2E_FILE'],
    ['Security checks', 'RELEASE_EVIDENCE_SECURITY_FILE']
  ]

  for (const [stepLabel, envVarName] of expectedMappings) {
    const escapedLabel = stepLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedVar = envVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`step\\.name === '${escapedLabel}'\\) env\\.${escapedVar}`)
    assert(pattern.test(masterValidate), `Missing ${stepLabel} -> ${envVarName} wiring in envForStep`)
  }
})
