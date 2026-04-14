import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VALID_PHASES = new Set(['all', 'preflight', 'postdeploy', 'restore', 'restore-drill'])

const PHASE_ARTIFACTS = {
  preflight: ['preflight-env-summary.json', 'backup.json', 'branch-parity.txt', 'startup-failfast.json', 'startup-failfast.txt'],
  postdeploy: [
    'postdeploy-health.json',
    'postdeploy-ready.json',
    'postdeploy-exports-queue.json',
    'postdeploy-telemetry-bundle.json',
    'postdeploy-evaluation-summary.json'
  ],
  restore: ['restore.json'],
  'restore-drill': ['restore-drill.json']
}

const REQUIRED_SUMMARY_FILES = [
  'validate-master-summary.json',
  'api-contract-summary.json',
  'integration-summary.json',
  'migration-summary.json',
  'smoke-summary.json',
  'security-summary.json',
  'e2e-summary.json',
  'postdeploy-evaluation-summary.json'
]

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
}

function remediationHint(lines = []) {
  return lines.filter(Boolean).map((line) => `\n   • ${line}`).join('')
}

function parseArgs(argv) {
  const options = {
    phase: 'all',
    releaseId: process.env.RELEASE_ID || '',
    evidenceDir: '',
    handoffFile: process.env.RELEASE_HANDOFF_DOC || '',
    checkHandoffPlaceholders: false,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--phase') {
      options.phase = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--release-id') {
      options.releaseId = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--evidence-dir') {
      options.evidenceDir = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--check-handoff-placeholders') {
      options.checkHandoffPlaceholders = true
      continue
    }
    if (token === '--handoff-file') {
      options.handoffFile = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }

    fail(`Unknown argument: ${token}`)
  }

  return options
}

function printHelp() {
  process.stdout.write('Validate release evidence completeness\n\n')
  process.stdout.write('Usage:\n')
  process.stdout.write(
    '  node scripts/validate-release-evidence.mjs --release-id <release-id> [--phase all|preflight|postdeploy|restore|restore-drill] [--check-handoff-placeholders] [--handoff-file <file>]\n\n'
  )
}

function parseJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON: ${filePath} (${error.message})`)
  }
}

function terminalStatus(status) {
  return status === 'passed' || status === 'failed'
}

function expectedPhaseStatus(commandPhase, phaseName) {
  if (commandPhase === 'all') {
    if (phaseName === 'preflight' || phaseName === 'postdeploy') return 'terminal'
    return 'skipped'
  }
  if (phaseName === commandPhase) return 'terminal'
  return 'skipped'
}

function assertManifestPhaseConsistency(manifest, commandPhase) {
  const phaseStatuses = manifest?.phaseStatuses
  if (!phaseStatuses || typeof phaseStatuses !== 'object') {
    fail('Manifest is missing phaseStatuses map.')
  }

  const expectedPhases = ['preflight', 'postdeploy', 'restore', 'restore-drill']
  for (const phaseName of expectedPhases) {
    const actualStatus = phaseStatuses?.[phaseName]?.status
    if (!actualStatus) {
      fail(`Manifest is missing status for phase "${phaseName}".`)
    }

    const expected = expectedPhaseStatus(commandPhase, phaseName)
    if (expected === 'terminal' && !terminalStatus(actualStatus)) {
      fail(
        `Manifest phase status mismatch for "${phaseName}". Command phase=${commandPhase}; expected passed/failed, got ${actualStatus}.`
      )
    }
    if (expected === 'skipped' && actualStatus !== 'skipped') {
      fail(
        `Manifest phase status mismatch for "${phaseName}". Command phase=${commandPhase}; expected skipped, got ${actualStatus}.`
      )
    }
  }
}

function validateArtifacts(evidenceDir, phases) {
  const missingArtifacts = []
  for (const phase of phases) {
    for (const artifactName of PHASE_ARTIFACTS[phase] || []) {
      const fullPath = resolve(evidenceDir, artifactName)
      if (!existsSync(fullPath)) {
        missingArtifacts.push(artifactName)
      }
    }
  }

  if (missingArtifacts.length > 0) {
    fail(
      `Missing required phase artifact(s): ${missingArtifacts.sort().join(', ')}.${remediationHint([
        `Re-run the matching phase command for this release-id (for example: npm run release:go-no-go -- --release-id ${JSON.stringify(process.env.RELEASE_ID || '<release-id>')} --phase ${phases[0]}).`,
        `Then re-run: node scripts/validate-release-evidence.mjs --release-id ${JSON.stringify(process.env.RELEASE_ID || '<release-id>')} --phase ${phases.length > 1 ? 'all' : phases[0]}.`
      ])}`
    )
  }
}

function validateSummaryFiles(evidenceDir, phases) {
  const required = new Set(['validate-master-summary.json'])
  if (phases.includes('preflight')) {
    for (const fileName of REQUIRED_SUMMARY_FILES) {
      if (fileName !== 'postdeploy-evaluation-summary.json') required.add(fileName)
    }
  }
  if (phases.includes('postdeploy')) {
    required.add('postdeploy-evaluation-summary.json')
  }

  const missing = []
  for (const fileName of required) {
    if (!existsSync(resolve(evidenceDir, fileName))) {
      missing.push(fileName)
    }
  }

  if (missing.length > 0) {
    fail(
      `Missing required summary file(s): ${missing.sort().join(', ')}.${remediationHint([
        'Re-run npm run validate:master to regenerate preflight gate summaries.',
        'If this is postdeploy-only validation, rerun --phase postdeploy to regenerate postdeploy-evaluation-summary.json.'
      ])}`
    )
  }
}

function parseBooleanSignal(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return null
}

function isReleaseRefEnvironment(env) {
  const githubRef = String(env.GITHUB_REF || '').trim()
  const githubRefName = String(env.GITHUB_REF_NAME || '').trim()
  const gitlabTag = String(env.CI_COMMIT_TAG || '').trim()
  const gitlabRefName = String(env.CI_COMMIT_REF_NAME || '').trim()

  if (githubRef.startsWith('refs/tags/')) return true
  if (githubRef.startsWith('refs/heads/release/') || githubRef.startsWith('refs/heads/release-')) return true
  if (githubRefName.startsWith('release/') || githubRefName.startsWith('release-')) return true
  if (gitlabTag) return true
  if (gitlabRefName.startsWith('release/') || gitlabRefName.startsWith('release-')) return true
  return false
}

function determineValidationMode(env) {
  const unpackedArtifact = parseBooleanSignal(env.RELEASE_EVIDENCE_UNPACKED_ARTIFACT)
  if (unpackedArtifact === true) return 'unpacked-artifact'
  const ci = parseBooleanSignal(env.CI)
  if (ci === true) return 'ci'
  return 'local'
}

function determineStrictE2EMode(env, { validationMode }) {
  const override = parseBooleanSignal(env.RELEASE_E2E_STRICT_MODE)
  if (override !== null) return override
  if (validationMode === 'ci' || validationMode === 'unpacked-artifact') return true
  return isReleaseRefEnvironment(env)
}

function validateE2ESummary(evidenceDir, { strictMode, validationMode }) {
  const e2eSummaryPath = resolve(evidenceDir, 'e2e-summary.json')
  const e2eSummary = parseJson(e2eSummaryPath, 'E2E summary')
  assertPassedGateSummary(e2eSummary, { fileName: 'e2e-summary.json', gateName: 'e2e' })

  const mode = e2eSummary?.executionMode
  if (mode !== 'browser' && mode !== 'fallback') {
    fail(
      `Invalid e2e-summary.json executionMode at ${e2eSummaryPath}. Expected "browser" or "fallback", got ${String(mode)}.${remediationHint([
        'Re-run npm run test:e2e to regenerate e2e-summary.json.',
        'If this is a release ref/strict mode, keep RELEASE_E2E_STRICT_MODE=1 and RELEASE_E2E_ALLOW_FALLBACK=0.'
      ])}`
    )
  }

  if (strictMode && mode !== 'browser') {
    fail(
      `E2E strict mode is required for validationMode=${validationMode}, but e2e-summary.json executionMode=${mode}.${remediationHint([
        'Re-provision browser binaries: npx playwright install --with-deps chromium.',
        'Re-run npm run test:e2e with strict settings: RELEASE_E2E_STRICT_MODE=1 RELEASE_E2E_ALLOW_FALLBACK=0.'
      ])}`
    )
  }

  const playwrightReport = e2eSummary?.details?.artifacts?.playwrightJsonReport
  if (!playwrightReport || typeof playwrightReport !== 'object') {
    fail(
      `e2e-summary.json is missing details.artifacts.playwrightJsonReport metadata.${remediationHint([
        'Re-run npm run test:e2e so the summary writer emits Playwright report metadata.',
        'Confirm artifacts/release-evidence/<release-id>/playwright-report.json is generated.'
      ])}`
    )
  }

  if (typeof playwrightReport.path !== 'string' || playwrightReport.path.trim().length === 0) {
    fail(
      `e2e-summary.json must include a non-empty details.artifacts.playwrightJsonReport.path value.${remediationHint([
        'Re-run npm run test:e2e and verify the writer sets details.artifacts.playwrightJsonReport.path.',
        'Do not hand-edit evidence files; regenerate from canonical gate commands.'
      ])}`
    )
  }

  if (playwrightReport.valid !== true) {
    fail(
      `e2e-summary.json details.artifacts.playwrightJsonReport.valid must be true.${remediationHint([
        'Inspect artifacts/release-evidence/<release-id>/playwright-report.json for parse errors.',
        'Re-run npm run test:e2e after fixing failing/invalid Playwright output generation.'
      ])}`
    )
  }

  if (!Number.isInteger(playwrightReport.suiteCount) || playwrightReport.suiteCount < 1) {
    fail(
      `e2e-summary.json details.artifacts.playwrightJsonReport.suiteCount must be an integer >= 1.${remediationHint([
        'Ensure the release-blocking Playwright suite executed and collected at least one suite.',
        'Re-run npm run test:e2e to regenerate e2e-summary.json and Playwright report.'
      ])}`
    )
  }

  const playwrightReportPath = resolve(evidenceDir, playwrightReport.path)
  if (!existsSync(playwrightReportPath)) {
    fail(
      `Playwright report referenced by e2e-summary.json is missing: ${playwrightReport.path}.${remediationHint([
        'Confirm details.artifacts.playwrightJsonReport.path is relative to artifacts/release-evidence/<release-id>/.',
        'Re-run npm run test:e2e to regenerate both e2e-summary.json and playwright-report.json.'
      ])}`
    )
  }

  const evidenceLinkage = e2eSummary?.details?.artifacts?.playwrightEvidenceLinkage
  if (!evidenceLinkage || typeof evidenceLinkage !== 'object') {
    fail(
      `e2e-summary.json is missing details.artifacts.playwrightEvidenceLinkage metadata.${remediationHint([
        'Re-run npm run test:e2e so the summary writer emits report/provisioning linkage metadata.',
        'Do not hand-edit e2e-summary.json; regenerate via canonical gate commands.'
      ])}`
    )
  }

  if (typeof evidenceLinkage.reportPath !== 'string' || evidenceLinkage.reportPath.trim().length === 0) {
    fail(
      `e2e-summary.json must include details.artifacts.playwrightEvidenceLinkage.reportPath.${remediationHint([
        'Re-run npm run test:e2e and verify report linkage metadata is populated.',
        'Confirm PLAYWRIGHT_JSON_REPORT/RELEASE_E2E_PLAYWRIGHT_REPORT is set in release gate environment.'
      ])}`
    )
  }

  if (strictMode && mode === 'browser') {
    if (typeof evidenceLinkage.provisioningArtifactPath !== 'string' || evidenceLinkage.provisioningArtifactPath.trim().length === 0) {
      fail(
        `Strict browser evidence requires details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath.${remediationHint([
          'Run release preflight so Flow A.4a writes playwright-provisioning.txt.',
          'Ensure RELEASE_E2E_PROVISIONING_ARTIFACT is passed to npm run validate:master.'
        ])}`
      )
    }

    const provisioningArtifactPath = resolve(evidenceDir, evidenceLinkage.provisioningArtifactPath)
    if (!existsSync(provisioningArtifactPath)) {
      fail(
        `Playwright provisioning artifact referenced by e2e-summary.json is missing: ${evidenceLinkage.provisioningArtifactPath}.${remediationHint([
          'Confirm details.artifacts.playwrightEvidenceLinkage.provisioningArtifactPath points to playwright-provisioning.txt under release evidence.',
          'Re-run release preflight to regenerate provisioning + E2E evidence artifacts.'
        ])}`
      )
    }
  }

}



function parseSummaryFile(evidenceDir, fileName, label) {
  const filePath = resolve(evidenceDir, fileName)
  if (!existsSync(filePath)) {
    fail(
      `Missing required summary file: ${filePath}.${remediationHint([
        'Re-run npm run validate:master for preflight summaries.',
        'Then re-run node scripts/validate-release-evidence.mjs --release-id <release-id> --phase <phase>.'
      ])}`
    )
  }
  return parseJson(filePath, label)
}

function assertPassedGateSummary(summary, { fileName, gateName }) {
  if (!summary || typeof summary !== 'object') {
    fail(`${fileName} must contain a JSON object.`)
  }

  if (summary.status !== 'passed') {
    fail(`${fileName} must have status=passed for release evidence completeness. Got ${String(summary.status)}.`)
  }

  if (summary.error !== null) {
    fail(`${fileName} must have error=null when status=passed.`)
  }

  if (summary.gate && summary.gate !== gateName) {
    fail(`${fileName} gate mismatch. Expected ${gateName}, got ${String(summary.gate)}.`)
  }
}

function validateKeyGateSummarySemantics(evidenceDir, phases) {
  if (!phases.includes('preflight')) return

  const gateSummaries = [
    { fileName: 'api-contract-summary.json', gateName: 'contract' },
    { fileName: 'integration-summary.json', gateName: 'integration' },
    { fileName: 'migration-summary.json', gateName: 'migration' },
    { fileName: 'smoke-summary.json', gateName: 'smoke' },
    { fileName: 'security-summary.json', gateName: 'security' },
    { fileName: 'validate-master-summary.json', gateName: 'validate-master' }
  ]

  for (const gate of gateSummaries) {
    const summary = parseSummaryFile(evidenceDir, gate.fileName, `${gate.gateName} summary`)
    assertPassedGateSummary(summary, gate)
  }
}

function validateHandoffDoc(handoffFile) {
  if (!handoffFile) {
    fail('Handoff placeholder check requested but no handoff file provided. Use --handoff-file or RELEASE_HANDOFF_DOC.')
  }
  const absolute = resolve(process.cwd(), handoffFile)
  if (!existsSync(absolute)) {
    fail(`Handoff file not found: ${handoffFile}`)
  }
  const content = readFileSync(absolute, 'utf8')
  const unresolvedCategories = []

  const unresolvedByCategory = {
    approverDecisions: [
      /\|\s*Release Manager\s*\|[^\n]*<GO\/NO-GO>/i,
      /\|\s*SRE\s*\/\s*On-call\s*\|[^\n]*<GO\/NO-GO>/i,
      /\|\s*QA Lead\s*\|[^\n]*<GO\/NO-GO>/i,
      /\|\s*Security Owner\s*\|[^\n]*<GO\/NO-GO>/i,
      /\|\s*Engineering Manager\s*\|[^\n]*<GO\/NO-GO>/i
    ],
    releaseIdentity: [
      /-\s*\*\*Release ID\*\*:\s*<release-id>/i,
      /-\s*\*\*Environment\*\*:\s*<staging\|production>/i,
      /-\s*\*\*Commit\s*\/\s*tag\*\*:\s*<git-sha>\s*\/\s*<tag-or-none>/i
    ],
    placeholdersInRequiredEvidencePaths: [/artifacts\/release-evidence\/<release-id>\//i],
    unresolvedSignerNames: [
      /\|\s*Release Manager\s*\|\s*<name>\s*\|/i,
      /\|\s*SRE\s*\/\s*On-call\s*\|\s*<name>\s*\|/i,
      /\|\s*QA Lead\s*\|\s*<name>\s*\|/i,
      /\|\s*Security Owner\s*\|\s*<name>\s*\|/i,
      /\|\s*Engineering Manager\s*\|\s*<name>\s*\|/i
    ],
    unresolvedTimestamps: [
      /-\s*\*\*Deployment window \(UTC\)\*\*:\s*<YYYY-MM-DD HH:MM[^>]*>/i,
      /\|\s*Release Manager\s*\|[^\n]*<YYYY-MM-DD HH:MM[^>]*>/i,
      /\|\s*SRE\s*\/\s*On-call\s*\|[^\n]*<YYYY-MM-DD HH:MM[^>]*>/i,
      /\|\s*QA Lead\s*\|[^\n]*<YYYY-MM-DD HH:MM[^>]*>/i,
      /\|\s*Security Owner\s*\|[^\n]*<YYYY-MM-DD HH:MM[^>]*>/i,
      /\|\s*Engineering Manager\s*\|[^\n]*<YYYY-MM-DD HH:MM[^>]*>/i,
      /-\s*\*\*Decision timestamp \(UTC\)\*\*:\s*<YYYY-MM-DD HH:MM[^>]*>/i
    ],
    unresolvedDecisionFields: [/^-\s*\*\*Decision\*\*:\s*<GO\/NO-GO>\s*$/im]
  }

  for (const [category, patterns] of Object.entries(unresolvedByCategory)) {
    if (patterns.some((pattern) => pattern.test(content))) {
      unresolvedCategories.push(category)
    }
  }

  const finalDecisionMatch = content.match(/^-\s*\*\*Decision\*\*:\s*(.+?)\s*$/im)
  if (!finalDecisionMatch) {
    unresolvedCategories.push('finalDecisionMissing')
  } else {
    const decisionValue = finalDecisionMatch[1].replace(/[`*_]/g, '').trim().toUpperCase()
    if (decisionValue !== 'GO' && decisionValue !== 'NO-GO') {
      unresolvedCategories.push('finalDecisionNotConcrete')
    }
  }

  if (unresolvedCategories.length > 0) {
    fail(
      `Handoff document has unresolved template content (${unresolvedCategories.join(', ')}): ${handoffFile}`
    )
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

if (!VALID_PHASES.has(options.phase)) {
  fail(`Invalid --phase value "${options.phase}". Use one of: all, preflight, postdeploy, restore, restore-drill.`)
}
if (!options.releaseId) {
  fail('Missing release id. Pass --release-id <release-id> or set RELEASE_ID.')
}

const evidenceDir = options.evidenceDir
  ? resolve(process.cwd(), options.evidenceDir)
  : resolve(process.cwd(), 'artifacts/release-evidence', options.releaseId)
if (!existsSync(evidenceDir)) {
  fail(`Evidence directory does not exist: ${evidenceDir}`)
}

const phasesToValidate =
  options.phase === 'all' ? ['preflight', 'postdeploy'] : [options.phase]

validateArtifacts(evidenceDir, phasesToValidate)
validateSummaryFiles(evidenceDir, phasesToValidate)
validateKeyGateSummarySemantics(evidenceDir, phasesToValidate)
const validationMode = determineValidationMode(process.env)
const strictE2EMode = determineStrictE2EMode(process.env, { validationMode })

if (phasesToValidate.includes('preflight')) {
  validateE2ESummary(evidenceDir, { strictMode: strictE2EMode, validationMode })
}

const manifestPath = resolve(evidenceDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  fail(`Missing release evidence manifest: ${manifestPath}`)
}
const manifest = parseJson(manifestPath, 'Release evidence manifest')
assertManifestPhaseConsistency(manifest, options.phase)

if (options.checkHandoffPlaceholders) {
  validateHandoffDoc(options.handoffFile)
}

process.stdout.write(`✅ Release evidence validation passed for release ${options.releaseId} (phase=${options.phase}, validationMode=${validationMode}, strictE2E=${strictE2EMode ? 'true' : 'false'}).\n`)
