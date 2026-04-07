import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, relative, basename } from 'node:path'
import { collectArtifactMetadata } from './release-evidence.mjs'

const PHASE_REQUIRED_FILES = {
  preflight: [
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

process.stdout.write(`✅ Release evidence bundle created for ${options.releaseId}.\n`)
process.stdout.write(`BUNDLE_PATH=${relative(process.cwd(), outputDir)}\n`)
process.stdout.write(`BUNDLE_MANIFEST=${relative(process.cwd(), bundleManifestPath)}\n`)
