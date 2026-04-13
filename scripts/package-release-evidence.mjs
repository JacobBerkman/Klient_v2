import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, relative, basename } from 'node:path'
import { collectArtifactMetadata } from './release-evidence.mjs'

const PHASE_REQUIRED_FILES = {
  preflight: [
    'preflight-env-summary.json',
    'backup.json',
    'branch-parity.txt',
    'startup-failfast.json',
    'startup-failfast.txt',
    'validate-master-summary.json',
    'api-contract-summary.json',
    'integration-summary.json',
    'migration-summary.json',
    'smoke-summary.json',
    'security-summary.json',
    'e2e-summary.json'
  ],
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

const GATE_POINTERS = [
  { gate: 'Runtime env preflight', owner: 'Release Manager + Security Owner', file: 'preflight-env-summary.json' },
  { gate: 'Backup metadata', owner: 'SRE / On-call', file: 'backup.json' },
  { gate: 'Branch parity', owner: 'Engineering Manager', file: 'branch-parity.txt' },
  { gate: 'Startup fail-fast', owner: 'Release Manager + API Lead', file: 'startup-failfast.json' },
  { gate: 'Validate master', owner: 'Release Manager', file: 'validate-master-summary.json' },
  { gate: 'API contract', owner: 'API Lead', file: 'api-contract-summary.json' },
  { gate: 'Integration suites', owner: 'QA Lead', file: 'integration-summary.json' },
  { gate: 'Migration checks', owner: 'Data/DB Owner', file: 'migration-summary.json' },
  { gate: 'Smoke', owner: 'Release Manager', file: 'smoke-summary.json' },
  { gate: 'E2E browser checks', owner: 'QA Lead', file: 'e2e-summary.json' },
  { gate: 'Security checks', owner: 'Security Owner', file: 'security-summary.json' },
  { gate: 'Postdeploy health/readiness/queue/telemetry policy', owner: 'SRE / On-call + Observability Owner', file: 'postdeploy-evaluation-summary.json' },
  { gate: 'Restore (live)', owner: 'Data/DB Owner + SRE', file: 'restore.json' },
  { gate: 'Restore drill (verify-only)', owner: 'Data/DB Owner + SRE', file: 'restore-drill.json' }
]

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    releaseId: process.env.RELEASE_ID || '',
    evidenceDir: '',
    checklistFile: 'docs/release-ready-checklist.md',
    outputDir: ''
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
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
    if (token === '--checklist-file') {
      options.checklistFile = argv[index + 1] || ''
      index += 1
      continue
    }
    if (token === '--output-dir') {
      options.outputDir = argv[index + 1] || ''
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
  process.stdout.write('Package release evidence for approver review.\n\n')
  process.stdout.write('Usage:\n')
  process.stdout.write(
    '  node scripts/package-release-evidence.mjs --release-id <release-id> [--evidence-dir <dir>] [--checklist-file <path>] [--output-dir <path>]\n\n'
  )
}

function parseJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON at ${filePath}: ${error.message}`)
  }
}

function summarizeGateStatus({ evidenceDir, manifest }) {
  const statuses = []

  for (const pointer of GATE_POINTERS) {
    const sourcePath = resolve(evidenceDir, pointer.file)
    if (!existsSync(sourcePath)) continue
    let status = 'present'
    let note = ''
    if (pointer.file.endsWith('.json')) {
      const payload = parseJson(sourcePath, `${pointer.file} summary`)
      if (typeof payload?.status === 'string') {
        status = payload.status
      }
      if (payload?.error) {
        note = String(payload.error)
      }
    }
    statuses.push({
      gate: pointer.gate,
      owner: pointer.owner,
      file: pointer.file,
      status,
      note
    })
  }

  const failed = statuses.filter((entry) => ['failed', 'error'].includes(String(entry.status).toLowerCase()))
  const phaseFailures = Object.entries(manifest.phaseStatuses || {})
    .filter(([, report]) => report?.status === 'failed')
    .map(([phaseName]) => phaseName)

  return { statuses, failed, phaseFailures }
}

function writeApprovalSummary({ outputDir, releaseId, manifest, gateStatus }) {
  const lines = [
    '# Approval Bundle Operator Summary',
    '',
    `- Release ID: \`${releaseId}\``,
    `- Source manifest: \`manifest.json\``,
    `- Phase statuses: ${Object.entries(manifest.phaseStatuses || {}).map(([phase, report]) => `${phase}=${report?.status || 'unknown'}`).join(', ')}`,
    ''
  ]

  if (gateStatus.failed.length > 0 || gateStatus.phaseFailures.length > 0) {
    lines.push('## Immediate attention required')
    if (gateStatus.phaseFailures.length > 0) {
      lines.push(`- Failed phase(s): ${gateStatus.phaseFailures.join(', ')}`)
    }
    for (const entry of gateStatus.failed) {
      lines.push(`- Gate: **${entry.gate}** (owner: ${entry.owner}) → failing artifact: \`${entry.file}\`${entry.note ? ` (${entry.note})` : ''}`)
    }
    lines.push('- Remediation: fix the failing gate owner action, rerun the matching phase command, then regenerate this approval bundle.')
    lines.push('')
  }

  lines.push('## Gate-to-artifact pointers')
  lines.push('| Gate | Owning role | Artifact | Current status |')
  lines.push('|---|---|---|---|')
  for (const entry of gateStatus.statuses) {
    lines.push(`| ${entry.gate} | ${entry.owner} | \`${entry.file}\` | ${entry.status} |`)
  }
  lines.push('')
  lines.push('Use `bundle-manifest.json` for SHA-256 file inventory and `manifest.json` for phase checkpoint history.')

  const summaryPath = resolve(outputDir, 'approval-summary.md')
  writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8')
  return summaryPath
}

function parseChecklistArtifactNames(checklistPath) {
  const content = readFileSync(checklistPath, 'utf8')
  const regex = /artifacts\/release-evidence\/\<release-id\>\/([A-Za-z0-9._-]+)/g
  const names = new Set()

  for (const match of content.matchAll(regex)) {
    names.add(match[1])
  }

  return names
}

function buildRequiredSet({ manifest, checklistArtifacts }) {
  const required = new Set(['manifest.json'])

  for (const [phaseName, statusReport] of Object.entries(manifest.phaseStatuses || {})) {
    const status = statusReport?.status
    if (status === 'passed' || status === 'failed') {
      for (const fileName of PHASE_REQUIRED_FILES[phaseName] || []) {
        if (checklistArtifacts.has(fileName) || fileName === 'manifest.json') {
          required.add(fileName)
        }
      }
    }
  }

  for (const fileRecord of manifest.files || []) {
    const fileName = basename(String(fileRecord.path || ''))
    if (fileName) required.add(fileName)
  }

  return [...required].sort((left, right) => left.localeCompare(right))
}

function writeBundleManifest({ outputDir, releaseId, requiredFiles, copiedFiles, sourceManifestPath }) {
  const metadata = collectArtifactMetadata(copiedFiles).map((artifact) => ({
    ...artifact,
    path: relative(process.cwd(), artifact.path)
  }))

  const payload = {
    schemaVersion: '1.0.0',
    releaseId,
    generatedAt: new Date().toISOString(),
    sourceManifest: relative(process.cwd(), sourceManifestPath),
    requiredFiles,
    bundledFiles: metadata,
    format: 'directory-manifest'
  }

  const manifestPath = resolve(outputDir, 'bundle-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return manifestPath
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
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

const checklistPath = resolve(process.cwd(), options.checklistFile)
if (!existsSync(checklistPath)) {
  fail(`Checklist file not found: ${checklistPath}`)
}

const manifestPath = resolve(evidenceDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  fail(`Missing release evidence manifest: ${manifestPath}`)
}

const manifest = parseJson(manifestPath, 'Release evidence manifest')
const checklistArtifacts = parseChecklistArtifactNames(checklistPath)
const requiredFiles = buildRequiredSet({ manifest, checklistArtifacts })

const outputDir = options.outputDir
  ? resolve(process.cwd(), options.outputDir)
  : resolve(evidenceDir, 'approval-bundle')

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

const missing = []
const copiedFiles = []
for (const fileName of requiredFiles) {
  const sourcePath = resolve(evidenceDir, fileName)
  if (!existsSync(sourcePath)) {
    missing.push(fileName)
    continue
  }
  if (!statSync(sourcePath).isFile()) {
    missing.push(fileName)
    continue
  }

  const targetPath = resolve(outputDir, fileName)
  copyFileSync(sourcePath, targetPath)
  copiedFiles.push(targetPath)
}

if (missing.length > 0) {
  fail(`Cannot create evidence bundle; missing required file(s): ${missing.join(', ')}`)
}

const bundleManifestPath = writeBundleManifest({
  outputDir,
  releaseId: options.releaseId,
  requiredFiles,
  copiedFiles,
  sourceManifestPath: manifestPath
})
const gateStatus = summarizeGateStatus({ evidenceDir, manifest })
const approvalSummaryPath = writeApprovalSummary({
  outputDir,
  releaseId: options.releaseId,
  manifest,
  gateStatus
})

process.stdout.write(`✅ Release evidence bundle created for ${options.releaseId}.\n`)
process.stdout.write(`BUNDLE_PATH=${relative(process.cwd(), outputDir)}\n`)
process.stdout.write(`BUNDLE_MANIFEST=${relative(process.cwd(), bundleManifestPath)}\n`)
process.stdout.write(`BUNDLE_SUMMARY=${relative(process.cwd(), approvalSummaryPath)}\n`)
