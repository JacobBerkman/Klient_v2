import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profiles-convert-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-profiles-convert'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store, firmName = 'Convert Test Firm') {
  const session = store.register({
    firmName,
    firstName: 'Pat',
    lastName: 'Operator',
    email: `pat-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'ConvertSecure123!'
  })
  return store.requireUser(session.token)
}

test('convertProspectToClient promotes a prospect, compacts the vacated stage, and bumps the board', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const first = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'First',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  const middle = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Middle',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  const last = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Last',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  assert.equal(middle.stageOrderIndex, 2)
  const initialBoard = store.getBoard(user)

  const result = store.convertProspectToClient(user, middle.id, { expectedUpdatedAt: middle.updatedAt })

  // Converted profile shape.
  assert.equal(result.profile.kind, 'client')
  assert.equal(result.profile.stage, null)
  assert.equal(result.profile.stageOrderIndex, null)
  assert.equal(result.profile.orderIndex, null)
  assert.equal(result.profile.status, 'active')

  // Board version bumped and the card removed from the board.
  assert.ok(result.board.boardVersion > initialBoard.boardVersion)
  const discovery = result.board.columns.find((column) => column.stage === 'discovery')
  assert.deepEqual(
    discovery.cards.map((card) => card.id),
    [first.id, last.id]
  )
  // Sibling compaction: remaining prospects keep contiguous 1..n indices.
  assert.deepEqual(
    discovery.cards.map((card) => card.stageOrderIndex),
    [1, 2]
  )
  assert.deepEqual(
    discovery.cards.map((card) => card.orderIndex),
    [1, 2]
  )

  // DB read-back (getProfileDetail hits the SQL profiles table).
  const detail = store.getProfileDetail(user, middle.id)
  assert.equal(detail.profile.kind, 'client')
  assert.equal(detail.profile.stage, null)

  // Terminal marker row present in stage history; analytics-safe synthetic toStage.
  const markerRow = detail.stageHistory.find((row) => row.toStage === 'converted')
  assert.ok(markerRow, 'expected a converted stage-change marker row')
  assert.equal(markerRow.fromStage, 'discovery')

  // Audit event written.
  const audit = store.listAudit(user)
  const convertedAudit = audit.find((event) => event.action === 'profile.converted')
  assert.ok(convertedAudit, 'expected a profile.converted audit event')
  assert.equal(convertedAudit.entityId, middle.id)
  assert.equal(convertedAudit.entityType, 'profile')
  // Metadata-only changeSet is stored under the canonical event's `after` field.
  assert.equal(convertedAudit.after.fromKind, 'prospect')
  assert.equal(convertedAudit.after.toKind, 'client')
  assert.equal(convertedAudit.after.fromStage, 'discovery')
})

test('convertProspectToClient leaves the prospect funnel counts coherent', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.createProfile(user, { kind: 'prospect', firstName: 'A', lastName: 'P', stage: 'discovery' })
  const target = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'B',
    lastName: 'P',
    stage: 'discovery'
  })

  const before = store.buildAnalyticsSnapshot(user)
  const beforeDiscovery = before.funnel.find((entry) => entry.stage === 'discovery')
  assert.equal(beforeDiscovery.count, 2)

  store.convertProspectToClient(user, target.id, {})

  const after = store.buildAnalyticsSnapshot(user)
  const afterDiscovery = after.funnel.find((entry) => entry.stage === 'discovery')
  // The converted profile leaves the funnel; the synthetic 'converted' marker
  // never appears as its own funnel stage.
  assert.equal(afterDiscovery.count, 1)
  assert.equal(
    after.funnel.some((entry) => entry.stage === 'converted'),
    false
  )
})

test('convertProspectToClient rejects a profile that is already a client', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const client = store.createProfile(user, { kind: 'client', firstName: 'Al', lastName: 'Ready' })

  assert.throws(
    () => store.convertProspectToClient(user, client.id, {}),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_NOT_PROSPECT')
      return true
    }
  )
})

test('convertProspectToClient does not find a prospect owned by another firm', async () => {
  const store = await loadStore()
  const firmA = createAdvisor(store, 'Firm A')
  const firmB = createAdvisor(store, 'Firm B')

  const prospect = store.createProfile(firmA, {
    kind: 'prospect',
    firstName: 'Cross',
    lastName: 'Firm',
    stage: 'discovery'
  })

  assert.throws(
    () => store.convertProspectToClient(firmB, prospect.id, {}),
    (error) => {
      assert.match(String(error.message), /not found/i)
      return true
    }
  )
})

test('convertProspectToClient rejects a stale expectedUpdatedAt with a 409 conflict', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const prospect = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Stale',
    lastName: 'Token',
    stage: 'discovery'
  })

  assert.throws(
    () => store.convertProspectToClient(user, prospect.id, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_UPDATE_CONFLICT')
      return true
    }
  )

  // The failed conversion rolled back: the profile is still a prospect on the board.
  const detail = store.getProfileDetail(user, prospect.id)
  assert.equal(detail.profile.kind, 'prospect')
})

test('moveProfileStage refuses to re-prospect a converted client', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const prospect = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Moved',
    lastName: 'Client',
    stage: 'discovery'
  })
  store.convertProspectToClient(user, prospect.id, {})

  assert.throws(
    () => store.moveProfileStage(user, prospect.id, 'analysis'),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_NOT_PROSPECT')
      return true
    }
  )

  // Still a client — the guard blocked the re-prospecting write.
  const detail = store.getProfileDetail(user, prospect.id)
  assert.equal(detail.profile.kind, 'client')
  assert.equal(detail.profile.stage, null)
})
