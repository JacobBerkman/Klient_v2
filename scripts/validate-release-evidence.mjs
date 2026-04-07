import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VALID_PHASES = new Set(['all', 'preflight', 'postdeploy', 'restore', 'restore-drill'])

const PHASE_ARTIFACTS = {
  preflight: ['backup.json', 'branch-parity.txt', 'startup-failfast.json', 'startup-failfast.txt'],
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
  'postdeploy-evaluation-summary.json'
]

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
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
    fail(`Missing required phase artifact(s): ${missingArtifacts.sort().join(', ')}`)
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
    fail(`Missing required summary file(s): ${missing.sort().join(', ')}`)
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
  const placeholderPatterns = [
    /\|\s*Release Manager\s*\|[^\n]*<GO\/NO-GO>/i,
    /\|\s*SRE\s*\/\s*On-call\s*\|[^\n]*<GO\/NO-GO>/i,
    /\|\s*QA Lead\s*\|[^\n]*<GO\/NO-GO>/i,
    /\|\s*Security Owner\s*\|[^\n]*<GO\/NO-GO>/i,
    /\|\s*Engineering Manager\s*\|[^\n]*<GO\/NO-GO>/i,
    /-\s*\*\*Decision\*\*:\s*<GO\/NO-GO>/i,
    /-\s*\*\*Decision timestamp \(UTC\)\*\*:\s*<YYYY-MM-DD HH:MM>/i
  ]

  const unresolved = placeholderPatterns.filter((pattern) => pattern.test(content))
  if (unresolved.length > 0) {
    fail(`Handoff document still contains placeholder approval decisions/timestamps: ${handoffFile}`)
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

const manifestPath = resolve(evidenceDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  fail(`Missing release evidence manifest: ${manifestPath}`)
}
const manifest = parseJson(manifestPath, 'Release evidence manifest')
assertManifestPhaseConsistency(manifest, options.phase)

if (options.checkHandoffPlaceholders) {
  validateHandoffDoc(options.handoffFile)
}

process.stdout.write(`✅ Release evidence validation passed for release ${options.releaseId} (phase=${options.phase}).\n`)
