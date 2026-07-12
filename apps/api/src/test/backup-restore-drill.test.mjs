import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { parseArtifact } from '../backup/artifact.mjs'
import { runBackup } from '../../../../scripts/backup.mjs'
import { restoreArtifact } from '../../../../scripts/restore.mjs'

const repoRoot = process.cwd()

// Load storage.mjs with its DB rooted at `tempDir` (mirrors the idiom in
// save-state-atomic.test.mjs). The cache-busting query keeps each test's
// storage instance isolated.
async function loadStorage(tempDir) {
  const previousCwd = process.cwd()
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const storage = await import(moduleUrl)
  process.chdir(previousCwd)
  return storage
}

function seedKnownRows(storage) {
  storage.saveState({
    marker: 'drill',
    firms: [
      { id: 'firm-1', name: 'Backup Firm', slug: 'backup-firm' },
      { id: 'firm-2', name: 'Second Firm', slug: 'second-firm' }
    ],
    users: [
      { id: 'user-1', firmId: 'firm-1', email: 'admin@firm1.test', role: 'admin', firstName: 'Ada', lastName: 'Admin' },
      { id: 'user-2', firmId: 'firm-2', email: 'agent@firm2.test', role: 'agent', firstName: 'Gus', lastName: 'Agent' }
    ],
    profiles: [],
    households: [],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [],
    notes: [],
    auditEvents: []
  })

  storage.upsertProfileRow({
    id: 'profile-1',
    firmId: 'firm-1',
    kind: 'prospect',
    firstName: 'Pat',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  storage.upsertProfileRow({
    id: 'profile-2',
    firmId: 'firm-1',
    kind: 'client',
    firstName: 'Casey',
    lastName: 'Client',
    stage: 'won'
  })

  storage.upsertNoteRow({
    id: 'note-1',
    firmId: 'firm-1',
    profileId: 'profile-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    body: 'first'
  })
  storage.upsertNoteRow({
    id: 'note-2',
    firmId: 'firm-1',
    profileId: 'profile-1',
    createdAt: '2026-01-02T00:00:00.000Z',
    body: 'second'
  })
  storage.upsertNoteRow({
    id: 'note-3',
    firmId: 'firm-1',
    profileId: 'profile-2',
    createdAt: '2026-01-03T00:00:00.000Z',
    body: 'third'
  })

  storage.insertAuditEvent({ id: 'audit-1', firmId: 'firm-1', action: 'login', timestamp: '2026-01-01T00:00:00.000Z' })
  storage.insertAuditEvent({ id: 'audit-2', firmId: 'firm-1', action: 'export', timestamp: '2026-01-02T00:00:00.000Z' })
  storage.insertAuditEvent({ id: 'audit-3', firmId: 'firm-2', action: 'login', timestamp: '2026-01-03T00:00:00.000Z' })
  storage.insertAuditEvent({ id: 'audit-4', firmId: 'system', action: 'backup', timestamp: '2026-01-04T00:00:00.000Z' })

  storage.upsertSession({
    token: 'sess-1',
    userId: 'user-1',
    firmId: 'firm-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    idleExpiresAt: '2026-01-01T01:00:00.000Z'
  })
  storage.upsertSession({
    token: 'sess-2',
    userId: 'user-2',
    firmId: 'firm-2',
    createdAt: '2026-01-02T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2026-02-02T00:00:00.000Z',
    idleExpiresAt: '2026-01-02T01:00:00.000Z'
  })
}

const COUNTED_TABLES = ['firms', 'profiles', 'notes', 'audit_events', 'sessions']

function countRows(dbPath) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    const counts = {}
    for (const table of COUNTED_TABLES) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    }
    return counts
  } finally {
    db.close()
  }
}

function quickCheck(dbPath) {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    return db.prepare('PRAGMA quick_check;').get()?.quick_check
  } finally {
    db.close()
  }
}

test('encrypted backup + restore drill: quick_check, row counts, tamper + wrong-key rejection', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-backup-drill-'))
  const backupDir = join(tempDir, 'backups')
  const key = randomBytes(32).toString('hex')
  const env = { BACKUP_ENCRYPTION_KEY: key, BACKUP_DIR: backupDir, BACKUP_RETENTION: '7' }

  const storage = await loadStorage(tempDir)
  try {
    seedKnownRows(storage)
    const sourceCounts = countRows(storage.DB_PATH)
    // Sanity: the seed actually populated every counted table.
    assert.deepEqual(sourceCounts, { firms: 2, profiles: 2, notes: 3, audit_events: 4, sessions: 2 })

    // (1) Encrypted backup via the real VACUUM INTO snapshot path.
    const backup = await runBackup({
      env,
      cwd: tempDir,
      createdAt: '2026-07-11T12:00:00.000Z',
      snapshotFn: (target) => storage.backupState(target)
    })
    assert.equal(backup.quickCheck, 'ok', 'snapshot quick_check must be ok before encryption')
    assert.equal(backup.header.algorithm, 'aes-256-gcm')
    assert.equal(backup.header.keySource, 'backup-key')
    assert.equal(backup.header.keyDerivation, 'raw-hex')

    // Artifact must be ciphertext, not a raw SQLite file.
    const artifactBytes = readFileSync(backup.artifactPath)
    assert.ok(
      !artifactBytes.subarray(0, 16).includes(Buffer.from('SQLite format 3')),
      'artifact must be encrypted at rest'
    )

    // (2) Restore to a temp path and verify.
    const restoredPath = join(tempDir, 'restored.db')
    const restore = restoreArtifact(backup.artifactPath, { targetPath: restoredPath, env })
    assert.equal(restore.ok, true)
    assert.equal(restore.checks.quickCheck, 'ok', '(a) restored DB quick_check must be ok')
    assert.equal(restore.checks.integrityCheck, 'ok', 'restored DB integrity_check must be ok')

    // (b) Row counts per table match the source exactly.
    assert.deepEqual(countRows(restoredPath), sourceCounts, '(b) restored row counts must match source')
    assert.equal(quickCheck(restoredPath), 'ok')

    // (c) A single flipped ciphertext byte makes restore FAIL (auth tag works).
    const { header } = parseArtifact(artifactBytes)
    const tampered = Buffer.from(artifactBytes)
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff
    const tamperedPath = join(backupDir, 'tampered.klbackup')
    writeFileSync(tamperedPath, tampered)
    assert.throws(
      () => restoreArtifact(tamperedPath, { targetPath: join(tempDir, 'tampered-out.db'), env }),
      /auth|unable to authenticate|integrity/i,
      '(c) tampered ciphertext must fail auth-tag verification'
    )
    assert.ok(header.iv && header.authTag, 'header carries iv + authTag')

    // (d) A wrong key fails to decrypt.
    const wrongEnv = { ...env, BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex') }
    assert.throws(
      () => restoreArtifact(backup.artifactPath, { targetPath: join(tempDir, 'wrongkey-out.db'), env: wrongEnv }),
      /auth|unable to authenticate|integrity/i,
      '(d) wrong key must fail to decrypt'
    )
  } finally {
    storage.closeDatabase()
  }
})

test('backup refuses to overwrite the live DB path without --force, and warns on APP_SECRET fallback', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-backup-guard-'))
  const backupDir = join(tempDir, 'backups')
  // No BACKUP_ENCRYPTION_KEY -> derive from APP_SECRET and flag the fallback.
  const env = { APP_SECRET: 'drill-app-secret-with-enough-entropy-1234', BACKUP_DIR: backupDir }

  const storage = await loadStorage(tempDir)
  try {
    seedKnownRows(storage)
    const backup = await runBackup({
      env,
      cwd: tempDir,
      createdAt: '2026-07-11T13:00:00.000Z',
      snapshotFn: (target) => storage.backupState(target)
    })
    assert.equal(backup.usingFallback, true, 'APP_SECRET fallback must be flagged')
    assert.equal(backup.header.keySource, 'app-secret')

    // Refuses to clobber the live DB path without force.
    assert.throws(
      () => restoreArtifact(backup.artifactPath, { targetPath: storage.DB_PATH, env, liveDbPath: storage.DB_PATH }),
      /--force/,
      'restore must refuse to overwrite the live DB without --force'
    )
    // With --force it proceeds (targeting a non-live path here to avoid racing the open handle).
    const forced = restoreArtifact(backup.artifactPath, {
      targetPath: join(tempDir, 'forced.db'),
      env,
      force: true,
      liveDbPath: join(tempDir, 'forced.db')
    })
    assert.equal(forced.ok, true)
  } finally {
    storage.closeDatabase()
  }
})
