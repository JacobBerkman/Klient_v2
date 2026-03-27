import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { backupState } from '../apps/api/src/storage.mjs'

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
const targetArg = process.argv[2]

try {
  const targetPath = targetArg ? resolve(process.cwd(), targetArg) : undefined
  const result = targetPath ? backupState(targetPath) : backupState()
  const artifactPath = resolve(result.targetPath)
  const stat = statSync(artifactPath)
  const quickCheck = sqliteQuickCheck(artifactPath)

  console.log(
    JSON.stringify(
      {
        operation: 'backup-db',
        status: 'succeeded',
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        artifact: {
          path: artifactPath,
          sizeBytes: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          sha256: sha256(artifactPath),
          sqliteQuickCheck: quickCheck
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
        operation: 'backup-db',
        status: 'failed',
        ok: false,
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
