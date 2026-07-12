import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { LATEST_SCHEMA_VERSION, migrations, runMigrations } from '../migrations/index.mjs'

const repoRoot = process.cwd()

async function loadStorage(tempDir) {
  const previousCwd = process.cwd()
  process.chdir(tempDir)
  const moduleUrl =
    pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href + `?t=${Date.now()}-${Math.random()}`
  const storage = await import(moduleUrl)
  process.chdir(previousCwd)
  return storage
}

// Fake-but-shaped envelope: migration and reencrypt (same active key) must
// never decode it, so byte-exact round-tripping is provable with arbitrary
// ciphertext bytes.
function envelope(keyId, marker) {
  return {
    keyId,
    alg: 'aes-256-gcm',
    createdAt: '2026-01-01T00:00:00.000Z',
    ciphertext: `aabbcc:ddeeff:${marker}`
  }
}

function buildLegacyBlob() {
  return {
    marker: 'legacy-pre-006',
    firms: [
      {
        id: 'firm-a',
        name: 'Alpha Firm',
        slug: 'alpha-firm',
        // Deliberately out-of-order + key-only entries: migration 006 must
        // apply the ported normalizeFirmStageConfig (sort by order, reassign
        // contiguous order values).
        stageConfig: {
          stages: [
            { id: 'discovery', label: 'Discovery', order: 2 },
            { key: 'analysis', order: 1 }
          ]
        }
      },
      { id: 'firm-b', name: 'Beta Firm', slug: 'beta-firm' }
    ],
    users: [],
    profiles: [
      {
        id: 'client-1',
        firmId: 'firm-a',
        kind: 'client',
        firstName: 'Morgan',
        lastName: 'Taylor',
        email: 'morgan@example.com',
        // status intentionally missing: normalization must default 'active'.
        pii: {
          maskingPolicy: 'role_based',
          ssnEncrypted: envelope('key-v1', 'ssn-bytes'),
          taxIdEncrypted: envelope('key-v1', 'taxid-bytes'),
          dobEncrypted: envelope('key-v1', 'dob-bytes')
        },
        householdId: 'household-1',
        spouseClientId: 'client-2',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'prospect-1',
        firmId: 'firm-a',
        kind: 'prospect',
        firstName: 'Casey',
        lastName: 'Jordan',
        stage: 'discovery',
        // Sparse, gapped ordering: the ported migrateProspectOrdering must
        // compact to 1..n preserving relative order (2 before 5).
        orderIndex: 5,
        stageOrderIndex: 5,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'prospect-2',
        firmId: 'firm-a',
        kind: 'prospect',
        firstName: 'Riley',
        lastName: 'Carter',
        stage: 'discovery',
        orderIndex: 2,
        stageOrderIndex: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'prospect-b1',
        firmId: 'firm-b',
        kind: 'prospect',
        firstName: 'Other',
        lastName: 'Tenant',
        stage: 'discovery',
        orderIndex: 9,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    households: [],
    stageChanges: [
      {
        id: 'change-1',
        firmId: 'firm-a',
        clientId: 'prospect-1',
        fromStage: null,
        toStage: 'discovery',
        changedByUserId: 'user-1',
        changedAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'change-2',
        firmId: 'firm-b',
        clientId: 'prospect-b1',
        toStage: 'discovery',
        changedByUserId: 'user-2',
        changedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    formTemplates: [],
    documentTemplates: [],
    templateAggregates: [],
    exportJobs: [],
    notes: [],
    auditEvents: [],
    boardVersions: { 'firm-a': 7 },
    pipelineStagesByFirm: { 'firm-a': [{ id: 'discovery', label: 'Discovery' }] },
    pipelineStages: [
      {
        id: 'stage-rec-1',
        firmId: 'firm-a',
        key: 'estate_planning',
        label: 'Estate Planning',
        color: '#123456',
        isActive: true,
        order: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deactivatedAt: null
      }
    ]
  }
}

// Creates a database that looks exactly like a deployed pre-006 install:
// schema at user_version 5 with the board entities still living in the blob
// (and the profiles table holding the old derived projection).
function createLegacyDatabase(tempDir, blob) {
  mkdirSync(join(tempDir, 'data'), { recursive: true })
  const db = new DatabaseSync(join(tempDir, 'data', 'app.db'))
  try {
    for (const migration of migrations) {
      if (migration.version > 5) continue
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.prepare("INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, datetime('now'))").run(
      JSON.stringify(blob)
    )
    // Old derived projection row (as the pre-006 saveState would have left
    // it) so the migration provably rebuilds rather than keeps stale rows.
    db.prepare(
      'INSERT INTO profiles (id, firm_id, kind, first_name, last_name, payload) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('prospect-1', 'firm-a', 'prospect', 'Casey', 'Jordan', JSON.stringify({ id: 'prospect-1', stale: true }))
  } finally {
    db.close()
  }
}

test('migration 006 backfills board entities from a legacy blob with ported fixups', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profiles-table-'))
  const blob = buildLegacyBlob()
  const originalPii = JSON.stringify(blob.profiles[0].pii)
  createLegacyDatabase(tempDir, blob)

  const storage = await loadStorage(tempDir)
  try {
    // Profiles: rebuilt from the blob, normalized, firm-scoped.
    const firmAProfiles = storage.listProfileRows({ firmId: 'firm-a' })
    assert.deepEqual(firmAProfiles.map((profile) => profile.id).sort(), ['client-1', 'prospect-1', 'prospect-2'])
    const client = storage.getProfileRow('client-1')
    assert.equal(client.status, 'active', 'normalization must default client status')
    assert.deepEqual(client.extensions, { schemaVersion: '1.0.0', schema: null, values: {} })
    assert.equal(client.financialSummary.netWorth, 0)
    assert.equal(client.householdId, 'household-1')
    assert.equal(client.spouseClientId, 'client-2')

    // PII envelopes must round-trip byte-exact through the migration.
    assert.equal(JSON.stringify(client.pii), originalPii)

    // Prospect ordering fixup: gapped 2/5 compacted to 1/2, relative order kept.
    const discovery = storage.listProspectRowsByStage('firm-a', 'discovery')
    assert.deepEqual(
      discovery.map((card) => [card.id, card.orderIndex, card.stageOrderIndex]),
      [
        ['prospect-2', 1, 1],
        ['prospect-1', 2, 2]
      ]
    )

    // Stale pre-006 projection rows are gone (payload was rebuilt).
    assert.equal(storage.getProfileRow('prospect-1').stale, undefined)
    assert.equal(storage.getProfileRow('prospect-1').firstName, 'Casey')

    // Stage changes are firm-scoped rows.
    assert.deepEqual(
      storage.listStageChangeRowsByFirm('firm-a').map((entry) => entry.id),
      ['change-1']
    )
    assert.deepEqual(
      storage.listStageChangeRowsByClient('firm-b', 'prospect-b1').map((entry) => entry.id),
      ['change-2']
    )

    // Board versions carried over; unknown firms lazily default to 1.
    assert.equal(storage.ensureBoardVersionRow('firm-a'), 7)
    assert.equal(storage.ensureBoardVersionRow('firm-unknown'), 1)

    // Pipeline stage records carried over.
    const stageRecords = storage.listPipelineStageRecordRows('firm-a')
    assert.deepEqual(
      stageRecords.map((record) => [record.key, record.isActive, record.order, record.color]),
      [['estate_planning', true, 1, '#123456']]
    )

    // Blob keys cleared; firm stage config normalized (analysis first).
    const inspect = new DatabaseSync(storage.DB_PATH, { readOnly: true })
    try {
      const parsed = JSON.parse(inspect.prepare('SELECT payload FROM app_state WHERE id = 1').get().payload)
      assert.deepEqual(parsed.profiles, [])
      assert.deepEqual(parsed.stageChanges, [])
      assert.deepEqual(parsed.boardVersions, {})
      assert.deepEqual(parsed.pipelineStagesByFirm, {})
      assert.deepEqual(parsed.pipelineStages, [])
      // Migration 009 moved firms out of the blob into the firms table, so the
      // ported firm stage-config normalization (from migration 006) is now
      // observed on the relational row rather than the blob array.
      assert.deepEqual(parsed.firms, [])
      const stageKeys = storage.getFirmRow('firm-a').stageConfig.stages.map((stage) => [stage.key, stage.order])
      assert.deepEqual(stageKeys, [
        ['analysis', 1],
        ['discovery', 2]
      ])
      assert.equal(Number(inspect.prepare('PRAGMA user_version').get().user_version), LATEST_SCHEMA_VERSION)
    } finally {
      inspect.close()
    }

    // loadState keeps the mirrors empty and does not resurrect blob copies.
    const state = storage.loadState(() => {
      throw new Error('seed factory must not run when a blob exists')
    })
    assert.deepEqual(state.profiles, [])
    assert.deepEqual(state.stageChanges, [])
    assert.deepEqual(state.boardVersions, {})
    assert.deepEqual(state.pipelineStages, [])

    // Re-running the migration runner is a no-op and keeps rows intact.
    const rerunDb = new DatabaseSync(storage.DB_PATH)
    try {
      const rerun = runMigrations(rerunDb)
      assert.equal(rerun.applied.length, 0)
      assert.equal(rerunDb.prepare('SELECT COUNT(*) AS count FROM profiles').get().count, 4)
    } finally {
      rerunDb.close()
    }
  } finally {
    storage.closeDatabase()
  }
})

test('reencrypt-pii script iterates profile rows and preserves envelopes byte-exact with an unchanged key', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profiles-reencrypt-'))
  const blob = buildLegacyBlob()
  const originalPii = JSON.stringify(blob.profiles[0].pii)
  createLegacyDatabase(tempDir, blob)

  const storage = await loadStorage(tempDir)
  try {
    const result = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/reencrypt-pii.mjs'), '--validate'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_SECRET: 'test-secret-for-profiles-table',
        PII_KEY_PROVIDER: 'env',
        PII_ACTIVE_KEY_ID: 'key-v1',
        PII_KEYRING: JSON.stringify({ 'key-v1': 'key-material-v1' })
      }
    })
    assert.equal(result.status, 0, `reencrypt script failed: ${result.stderr}`)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.ok, true)
    assert.equal(summary.rotatedProfiles, 0, 'active-key envelopes must not be rotated')
    assert.equal(summary.rotatedFields, 0)
    assert.equal(summary.activeKeyId, 'key-v1')
    assert.equal(summary.validation.ok, true)
    assert.ok(summary.validation.profilesChecked >= 1)
    assert.equal(summary.validation.keyMismatchCount, 0)

    // Byte-exact after migration AND a reencrypt pass.
    const client = storage.getProfileRow('client-1')
    assert.equal(JSON.stringify(client.pii), originalPii)
  } finally {
    storage.closeDatabase()
  }
})

test('board version guard rejects stale increments under simulated concurrent writers', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-board-version-guard-'))
  const storage = await loadStorage(tempDir)
  try {
    assert.equal(storage.ensureBoardVersionRow('firm-guard'), 1)

    // Two writers read version 1; only the first guarded increment lands.
    assert.equal(storage.incrementBoardVersionGuarded('firm-guard', 1), 2)
    assert.equal(storage.incrementBoardVersionGuarded('firm-guard', 1), null)
    assert.equal(storage.ensureBoardVersionRow('firm-guard'), 2)

    // The losing writer retries with the fresh version and succeeds.
    assert.equal(storage.incrementBoardVersionGuarded('firm-guard', 2), 3)
    assert.equal(storage.ensureBoardVersionRow('firm-guard'), 3)
  } finally {
    storage.closeDatabase()
  }
})

test('profile rows are firm-scoped: cross-tenant reads miss, unscoped reads resolve for ownership checks', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profiles-scoping-'))
  createLegacyDatabase(tempDir, buildLegacyBlob())

  const storage = await loadStorage(tempDir)
  try {
    // Scoped read with the wrong firm behaves like a missing row.
    assert.equal(storage.getProfileRow('client-1', { firmId: 'firm-b' }), null)
    // Unscoped read resolves so the store's tenancy validator can raise the
    // ownership error itself.
    assert.equal(storage.getProfileRow('client-1')?.firmId, 'firm-a')

    assert.deepEqual(
      storage.listProfileRows({ firmId: 'firm-b' }).map((profile) => profile.id),
      ['prospect-b1']
    )
    assert.deepEqual(
      storage.listProspectRowsByStage('firm-b', 'discovery').map((card) => card.id),
      ['prospect-b1']
    )
    assert.equal(storage.countProspectRowsInStage('firm-b', 'discovery'), 1)
    assert.equal(storage.countProspectRowsInStage('firm-b', 'analysis'), 0)
    assert.equal(storage.findClientProfileRowByEmail('firm-b', 'morgan@example.com'), null)
    assert.equal(storage.findClientProfileRowByEmail('firm-a', 'MORGAN@example.com')?.id, 'client-1')
  } finally {
    storage.closeDatabase()
  }
})
