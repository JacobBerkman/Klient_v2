import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DB_PATH } from '../apps/api/src/storage.mjs'

function failUsage(message = '') {
  if (message) {
    console.error(message)
  }
  console.error(
    'Usage: node scripts/restore-db.mjs <backup-file> [--verify-only] [--verify-target <temp-path>] [--evidence-label <label>]'
  )
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    sourcePath: '',
    verifyOnly: false,
    verifyTarget: '',
    evidenceLabel: ''
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--verify-only') {
      options.verifyOnly = true
      continue
    }

    if (token === '--verify-target') {
      options.verifyTarget = argv[index + 1] || ''
      index += 1
      continue
    }

    if (token === '--evidence-label') {
      options.evidenceLabel = argv[index + 1] || ''
      index += 1
      continue
    }

    if (token === '--help' || token === '-h') {
      failUsage()
    }

    if (token.startsWith('--')) {
      failUsage(`Unknown argument: ${token}`)
    }

    if (!options.sourcePath) {
      options.sourcePath = token
      continue
    }

    failUsage(`Unexpected extra argument: ${token}`)
  }

  if (!options.sourcePath) {
    failUsage('Missing required backup file argument.')
  }

  return options
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function sqliteQuickCheck(filePath) {
  const db = new DatabaseSync(filePath, { open: true, readOnly: true })
  try {
    const row = db.prepare('PRAGMA quick_check;').get()
    return row?.quick_check || 'unknown'
  } finally {
    db.close()
  }
}

const options = parseArgs(process.argv.slice(2))
const resolvedSource = resolve(process.cwd(), options.sourcePath)
if (!existsSync(resolvedSource)) {
  console.error(`Backup file not found: ${resolvedSource}`)
  process.exit(1)
}

const startedAt = new Date().toISOString()
const liveRestore = !options.verifyOnly
const resolvedTarget = liveRestore
  ? DB_PATH
  : resolve(process.cwd(), options.verifyTarget || `tmp/restore-verify-${Date.now()}.db`)

const executionMode = liveRestore ? 'live-restore' : 'verify-only-drill'
const evidenceLabel = options.evidenceLabel || executionMode

try {
  mkdirSync(dirname(resolvedTarget), { recursive: true })
  copyFileSync(resolvedSource, resolvedTarget)

  const sourceStat = statSync(resolvedSource)
  const targetStat = statSync(resolvedTarget)
  const sourceSha = sha256(resolvedSource)
  const targetSha = sha256(resolvedTarget)

  const sourceQuickCheck = sqliteQuickCheck(resolvedSource)
  const targetQuickCheck = sqliteQuickCheck(resolvedTarget)

  const checks = {
    sizeMatch: sourceStat.size === targetStat.size,
    sha256Match: sourceSha === targetSha,
    sourceQuickCheckOk: sourceQuickCheck === 'ok',
    targetQuickCheckOk: targetQuickCheck === 'ok'
  }

  const response = {
    operation: 'restore-db',
    status: 'succeeded',
    ok: checks.sizeMatch && checks.sha256Match && checks.sourceQuickCheckOk && checks.targetQuickCheckOk,
    executionMode,
    evidenceLabel,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: {
      path: resolvedSource,
      sizeBytes: sourceStat.size,
      modifiedAt: new Date(sourceStat.mtimeMs).toISOString(),
      sha256: sourceSha,
      sqliteQuickCheck: sourceQuickCheck
    },
    restoreTarget: {
      path: resolvedTarget,
      kind: liveRestore ? 'live-database-path' : 'verify-temporary-path',
      sizeBytes: targetStat.size,
      modifiedAt: new Date(targetStat.mtimeMs).toISOString(),
      sha256: targetSha,
      sqliteQuickCheck: targetQuickCheck
    },
    checks
  }

  console.log(JSON.stringify(response, null, 2))

  if (!response.ok) {
    process.exitCode = 1
  }

  if (options.verifyOnly && existsSync(resolvedTarget)) {
    rmSync(resolvedTarget, { force: true })
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        operation: 'restore-db',
        status: 'failed',
        ok: false,
        executionMode,
        evidenceLabel,
        sourcePath: resolvedSource,
        restoreTargetPath: resolvedTarget,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      },
      null,
      2
    )
  )
  process.exit(1)
}
