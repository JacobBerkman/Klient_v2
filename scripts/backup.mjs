// Encrypted, scheduled-friendly database backup for Kinetic Klient.
//
// Pipeline:
//   1. VACUUM INTO a temp file (WAL-safe, consistent, checkpointed snapshot)
//      via storage.backupState().
//   2. PRAGMA quick_check the snapshot.
//   3. Encrypt the snapshot at rest with AES-256-GCM (see backup/artifact.mjs)
//      under BACKUP_ENCRYPTION_KEY (fallback: APP_SECRET, with a loud warning).
//   4. Write the artifact to BACKUP_DIR (default data/backups).
//   5. Apply retention: keep the newest BACKUP_RETENTION artifacts, delete older.
//
// Usage:
//   node scripts/backup.mjs [--out <path>] [--label <label>]
//
// Env:
//   BACKUP_ENCRYPTION_KEY  dedicated key (64 hex = raw; else scrypt passphrase)
//   APP_SECRET             fallback key material (warns if used)
//   BACKUP_DIR             output directory (default data/backups)
//   BACKUP_RETENTION       number of artifacts to keep (default 7)

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { encryptBackup } from '../apps/api/src/backup/artifact.mjs'

export const ARTIFACT_EXTENSION = '.klbackup'
const DEFAULT_BACKUP_DIR = 'data/backups'
const DEFAULT_RETENTION = 7

export function sqliteQuickCheck(filePath) {
  const db = new DatabaseSync(filePath, { open: true, readOnly: true })
  try {
    const row = db.prepare('PRAGMA quick_check;').get()
    return row?.quick_check || 'unknown'
  } finally {
    db.close()
  }
}

/**
 * Keep the newest `keep` artifacts in `dir`; delete the rest. Returns the
 * paths that were removed. Ordering is by mtime (newest first) with the
 * filename as a stable tiebreaker.
 */
export function applyRetention(dir, keep) {
  const limit = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_RETENTION
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const artifacts = entries
    .filter((name) => name.endsWith(ARTIFACT_EXTENSION))
    .map((name) => {
      const full = resolve(dir, name)
      return { full, mtimeMs: statSync(full).mtimeMs, name }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))

  const removed = []
  for (const artifact of artifacts.slice(limit)) {
    rmSync(artifact.full, { force: true })
    removed.push(artifact.full)
  }
  return removed
}

/**
 * Encrypt an existing plaintext DB file into an artifact at `artifactPath`.
 * Runs quick_check on the source first. Returns metadata about the artifact.
 */
export function encryptDbFileToArtifact(
  sourceDbPath,
  artifactPath,
  { createdAt, env = process.env, label = null } = {}
) {
  const quickCheck = sqliteQuickCheck(sourceDbPath)
  if (quickCheck !== 'ok') {
    throw new Error(`Refusing to back up: PRAGMA quick_check on the snapshot returned "${quickCheck}".`)
  }
  const plaintext = readFileSync(sourceDbPath)
  const { artifact, header, usingFallback } = encryptBackup(plaintext, { createdAt, env, sourceLabel: label })
  mkdirSync(resolve(artifactPath, '..'), { recursive: true })
  writeFileSync(artifactPath, artifact)
  return {
    artifactPath: resolve(artifactPath),
    sizeBytes: statSync(artifactPath).size,
    quickCheck,
    header,
    usingFallback
  }
}

/**
 * Full backup orchestration. `snapshotFn(tempPath)` produces a plaintext DB
 * snapshot at tempPath (defaults to storage.backupState via VACUUM INTO).
 */
export async function runBackup({
  env = process.env,
  cwd = process.cwd(),
  createdAt = new Date().toISOString(),
  label = null,
  outPath = null,
  snapshotFn = null
} = {}) {
  const backupDir = resolve(cwd, env.BACKUP_DIR || DEFAULT_BACKUP_DIR)
  const retention = Number.parseInt(env.BACKUP_RETENTION || '', 10) || DEFAULT_RETENTION
  mkdirSync(backupDir, { recursive: true })

  const stamp = createdAt.replace(/[:.]/g, '-')
  const artifactPath = outPath ? resolve(cwd, outPath) : resolve(backupDir, `backup-${stamp}${ARTIFACT_EXTENSION}`)
  const tempSnapshot = resolve(backupDir, `.snapshot-${stamp}.db`)

  let snapshot = snapshotFn
  if (!snapshot) {
    const storage = await import('../apps/api/src/storage.mjs')
    snapshot = (target) => storage.backupState(target)
  }

  let result
  try {
    snapshot(tempSnapshot)
    result = encryptDbFileToArtifact(tempSnapshot, artifactPath, { createdAt, env, label })
  } finally {
    rmSync(tempSnapshot, { force: true })
    rmSync(`${tempSnapshot}-wal`, { force: true })
    rmSync(`${tempSnapshot}-shm`, { force: true })
  }

  const removed = applyRetention(backupDir, retention)
  return { ...result, backupDir, retention, removed }
}

async function main() {
  const args = process.argv.slice(2)
  const options = { outPath: null, label: null }
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--out') {
      options.outPath = args[index + 1] || null
      index += 1
    } else if (token === '--label') {
      options.label = args[index + 1] || null
      index += 1
    }
  }

  const startedAt = new Date().toISOString()
  try {
    const result = await runBackup({ createdAt: startedAt, ...options })
    if (result.usingFallback) {
      process.emitWarning(
        'BACKUP_ENCRYPTION_KEY is not set — the backup was encrypted with a key derived from APP_SECRET. ' +
          'Set a dedicated BACKUP_ENCRYPTION_KEY so backup and app secrets can be rotated independently.',
        { code: 'KLIENT_BACKUP_FALLBACK_KEY' }
      )
    }
    console.log(
      JSON.stringify(
        {
          operation: 'backup',
          status: 'succeeded',
          ok: true,
          startedAt,
          finishedAt: new Date().toISOString(),
          artifact: {
            path: result.artifactPath,
            sizeBytes: result.sizeBytes,
            algorithm: result.header.algorithm,
            keySource: result.header.keySource,
            keyDerivation: result.header.keyDerivation,
            createdAt: result.header.createdAt,
            plaintextSha256: result.header.plaintextSha256,
            sqliteQuickCheck: result.quickCheck
          },
          retention: { keep: result.retention, dir: result.backupDir, removed: result.removed }
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          operation: 'backup',
          status: 'failed',
          ok: false,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: { message: error instanceof Error ? error.message : String(error) }
        },
        null,
        2
      )
    )
    process.exit(1)
  }
}

if (
  import.meta.url === pathToFileURL(process.argv[1] || '').href ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  await main()
}
