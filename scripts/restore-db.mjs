import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DB_PATH } from '../apps/api/src/storage.mjs'

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('Usage: node scripts/restore-db.mjs <backup-file>')
  process.exit(1)
}

const resolvedSource = resolve(process.cwd(), sourcePath)
if (!existsSync(resolvedSource)) {
  console.error(`Backup file not found: ${resolvedSource}`)
  process.exit(1)
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

const startedAt = new Date().toISOString()

try {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  copyFileSync(resolvedSource, DB_PATH)

  const sourceStat = statSync(resolvedSource)
  const targetStat = statSync(DB_PATH)
  const sourceSha = sha256(resolvedSource)
  const targetSha = sha256(DB_PATH)

  console.log(
    JSON.stringify(
      {
        operation: 'restore-db',
        status: 'succeeded',
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: {
          path: resolvedSource,
          sizeBytes: sourceStat.size,
          modifiedAt: new Date(sourceStat.mtimeMs).toISOString(),
          sha256: sourceSha,
          sqliteQuickCheck: sqliteQuickCheck(resolvedSource)
        },
        target: {
          path: DB_PATH,
          sizeBytes: targetStat.size,
          modifiedAt: new Date(targetStat.mtimeMs).toISOString(),
          sha256: targetSha,
          sqliteQuickCheck: sqliteQuickCheck(DB_PATH)
        },
        checks: {
          sizeMatch: sourceStat.size === targetStat.size,
          sha256Match: sourceSha === targetSha
        }
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(
    JSON.stringify(
      {
        operation: 'restore-db',
        status: 'failed',
        ok: false,
        sourcePath: resolvedSource,
        targetPath: DB_PATH,
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
