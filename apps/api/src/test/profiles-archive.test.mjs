import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-profiles-archive-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-profiles-archive'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store, firmName = 'Archive Test Firm') {
  const session = store.register({
    firmName,
    firstName: 'Pat',
    lastName: 'Operator',
    email: `pat-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'ArchiveSecure123!'
  })
  return store.requireUser(session.token)
}

test('archiving a prospect removes it from the board, compacts the vacated stage, and bumps the board', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const first = store.createProfile(user, { kind: 'prospect', firstName: 'First', lastName: 'P', stage: 'discovery' })
  const middle = store.createProfile(user, { kind: 'prospect', firstName: 'Middle', lastName: 'P', stage: 'discovery' })
  const last = store.createProfile(user, { kind: 'prospect', firstName: 'Last', lastName: 'P', stage: 'discovery' })
  const initialBoard = store.getBoard(user)

  const result = store.archiveProfile(user, middle.id, { expectedUpdatedAt: middle.updatedAt })

  assert.ok(result.profile.archivedAt, 'archivedAt is stamped')
  assert.equal(result.profile.kind, 'prospect', 'kind stays prospect')
  assert.equal(result.profile.stage, null, 'stage cleared like conversion')
  assert.equal(result.profile.archivedFromStage, 'discovery', 'previous stage remembered for restore')

  assert.ok(result.board.boardVersion > initialBoard.boardVersion, 'board version bumped')
  const discovery = result.board.columns.find((column) => column.stage === 'discovery')
  assert.deepEqual(
    discovery.cards.map((card) => card.id),
    [first.id, last.id],
    'archived card removed from the board'
  )
  assert.deepEqual(
    discovery.cards.map((card) => card.stageOrderIndex),
    [1, 2],
    'siblings compacted to contiguous 1..n'
  )

  // Still readable at its detail route.
  const detail = store.getProfileDetail(user, middle.id)
  assert.ok(detail.profile.archivedAt)

  const audit = store.listAudit(user)
  assert.ok(
    audit.find((event) => event.action === 'profile.archived' && event.entityId === middle.id),
    'profile.archived audit event written'
  )
})

test('archiving a prospect drops it from prospect lists, dashboard counts, and analytics', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.createProfile(user, { kind: 'prospect', firstName: 'A', lastName: 'P', stage: 'discovery' })
  const target = store.createProfile(user, { kind: 'prospect', firstName: 'B', lastName: 'P', stage: 'discovery' })

  const dashBefore = store.getDashboard(user)
  assert.equal(dashBefore.stats.prospects, 2)
  const analyticsBefore = store.buildAnalyticsSnapshot(user)
  assert.equal(analyticsBefore.funnel.find((entry) => entry.stage === 'discovery').count, 2)

  store.archiveProfile(user, target.id, {})

  const dashAfter = store.getDashboard(user)
  assert.equal(dashAfter.stats.prospects, 1, 'dashboard prospect count drops')
  assert.equal(dashAfter.stats.totalProfiles, 1, 'total profiles drops')

  const analyticsAfter = store.buildAnalyticsSnapshot(user)
  assert.equal(analyticsAfter.funnel.find((entry) => entry.stage === 'discovery').count, 1, 'funnel excludes archived')
  assert.equal(analyticsAfter.profileCount, 1)

  const list = store.listProfiles(user, 'prospect')
  assert.equal(list.length, 1, 'archived prospect excluded from list by default')
  const listWithArchived = store.listProfiles(user, 'prospect', '', { includeArchived: true })
  assert.equal(listWithArchived.length, 2, 'includeArchived opts back in')
})

test('archiving a client leaves lists excluding it but keeps the detail readable', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const client = store.createProfile(user, { kind: 'client', firstName: 'Cli', lastName: 'Ent' })
  const result = store.archiveProfile(user, client.id, {})
  assert.ok(result.profile.archivedAt)
  assert.equal(result.profile.kind, 'client')

  assert.equal(store.listProfiles(user, 'client').length, 0, 'archived client excluded from list')
  assert.equal(store.getDashboard(user).stats.clients, 0, 'dashboard client count drops')
  const detail = store.getProfileDetail(user, client.id)
  assert.ok(detail.profile.archivedAt, 'still readable at detail route')
})

test('restoring a prospect re-enters the END of its previous stage when that stage is still active', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.createProfile(user, { kind: 'prospect', firstName: 'Keep', lastName: 'One', stage: 'discovery' })
  const target = store.createProfile(user, { kind: 'prospect', firstName: 'Round', lastName: 'Trip', stage: 'discovery' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Keep', lastName: 'Two', stage: 'discovery' })

  store.archiveProfile(user, target.id, {})
  const restored = store.restoreProfile(user, target.id, {})

  assert.equal(restored.profile.archivedAt, null)
  assert.equal(restored.profile.stage, 'discovery', 're-enters previous stage')
  const discovery = restored.board.columns.find((column) => column.stage === 'discovery')
  assert.equal(discovery.cards[discovery.cards.length - 1].id, target.id, 're-enters at the END of the stage')
  assert.deepEqual(
    discovery.cards.map((card) => card.stageOrderIndex),
    [1, 2, 3],
    'contiguous order indices after restore'
  )
})

test('restoring a prospect whose previous stage was deactivated falls back to the default start stage', async () => {
  const store = await loadStore()
  const admin = createAdvisor(store)

  // Create a custom stage, seat a prospect there, archive it, then deactivate it.
  const nurture = store.createPipelineStage(admin, { key: 'nurture', label: 'Nurture' })
  const target = store.createProfile(admin, { kind: 'prospect', firstName: 'Fall', lastName: 'Back', stage: 'nurture' })
  store.archiveProfile(admin, target.id, {})
  store.deactivatePipelineStage(admin, nurture.id)

  const restored = store.restoreProfile(admin, target.id, {})
  const defaultStage = store.getBoard(admin).columns.find((column) => column.active).stage
  assert.equal(restored.profile.stage, defaultStage, 'falls back to the default start stage')
})

test('archiving is blocked when the profile has an active portal link', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const client = store.createProfile(user, { kind: 'client', firstName: 'Portal', lastName: 'User' })
  const link = store.createPortalLink(user, client.id, { expiresInHours: 48, maxUses: 5 })

  assert.throws(
    () => store.archiveProfile(user, client.id, {}),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_HAS_ACTIVE_PORTAL_LINKS')
      assert.deepEqual(error.details.activePortalLinkIds, [link.id])
      return true
    }
  )

  // Revoking the link clears the guard.
  store.revokePortalLink(user, link.id)
  const result = store.archiveProfile(user, client.id, {})
  assert.ok(result.profile.archivedAt)
})

test('creating a portal link for an archived profile is rejected', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const client = store.createProfile(user, { kind: 'client', firstName: 'No', lastName: 'Link' })
  store.archiveProfile(user, client.id, {})
  assert.throws(
    () => store.createPortalLink(user, client.id, {}),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_ARCHIVED')
      return true
    }
  )
})

test('archive rejects a stale expectedUpdatedAt with a 409 conflict and rolls back', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const prospect = store.createProfile(user, { kind: 'prospect', firstName: 'Stale', lastName: 'P', stage: 'discovery' })

  assert.throws(
    () => store.archiveProfile(user, prospect.id, { expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_UPDATE_CONFLICT')
      return true
    }
  )

  const detail = store.getProfileDetail(user, prospect.id)
  assert.equal(detail.profile.archivedAt ?? null, null, 'failed archive rolled back — still active on the board')
  assert.equal(detail.profile.stage, 'discovery')
})

test('archiving an already-archived profile is a 409, and restoring a non-archived profile is a 409', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const prospect = store.createProfile(user, { kind: 'prospect', firstName: 'Idem', lastName: 'P', stage: 'discovery' })

  assert.throws(
    () => store.restoreProfile(user, prospect.id, {}),
    (error) => {
      assert.equal(error.code, 'PROFILE_NOT_ARCHIVED')
      return true
    }
  )
  store.archiveProfile(user, prospect.id, {})
  assert.throws(
    () => store.archiveProfile(user, prospect.id, {}),
    (error) => {
      assert.equal(error.code, 'PROFILE_ALREADY_ARCHIVED')
      return true
    }
  )
})

test('an archived prospect cannot be moved on the board (409 PROFILE_ARCHIVED) and the board is unchanged', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const keep = store.createProfile(user, { kind: 'prospect', firstName: 'Keep', lastName: 'P', stage: 'discovery' })
  const target = store.createProfile(user, { kind: 'prospect', firstName: 'Ghost', lastName: 'P', stage: 'discovery' })

  store.archiveProfile(user, target.id, {})
  const boardBefore = store.getBoard(user)

  // Direct stage move (PATCH /api/profiles/:id/stage path).
  assert.throws(
    () => store.moveProfileStage(user, target.id, 'discovery'),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.code, 'PROFILE_ARCHIVED')
      return true
    }
  )
  // Reorder path (POST /api/pipeline/stages/reorder).
  assert.throws(
    () => store.reorderBoard(user, { profileId: target.id, toStage: 'discovery', beforeProfileId: keep.id }),
    (error) => {
      assert.equal(error.code, 'PROFILE_ARCHIVED')
      return true
    }
  )

  // The archived row never re-entered the board, and the board is byte-identical.
  const boardAfter = store.getBoard(user)
  assert.equal(boardAfter.boardVersion, boardBefore.boardVersion, 'board version not bumped by the rejected move')
  const discoveryAfter = boardAfter.columns.find((column) => column.stage === 'discovery')
  assert.deepEqual(
    discoveryAfter.cards.map((card) => card.id),
    [keep.id],
    'archived prospect stayed off the board'
  )
  // Still archived (no split-brain): stage remains null.
  const detail = store.getProfileDetail(user, target.id)
  assert.ok(detail.profile.archivedAt)
  assert.equal(detail.profile.stage, null)
})

test('archiving a client suspends portal/client auth resolution (archived email login is not found)', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const email = `client-${Math.random().toString(16).slice(2)}@example.com`
  const client = store.createProfile(user, { kind: 'client', firstName: 'Portal', lastName: 'Client', email })
  const clientUser = { id: 'client-user', firmId: user.firmId, email, role: 'client' }

  // Before archive, the client profile resolves for the client session.
  assert.equal(store.getClientWorkspace(clientUser).profile.id, client.id)

  store.archiveProfile(user, client.id, {})

  // After archive, auth resolution treats the client as if it does not exist.
  assert.throws(() => store.getClientWorkspace(clientUser), /not found/i)
})

test('household archive stamps only the household row and excludes it from listings; restore brings it back', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const primary = store.createProfile(user, { kind: 'client', firstName: 'Head', lastName: 'Household' })
  const household = store.createHousehold(user, { name: 'Household One', primaryClientId: primary.id })

  const archived = store.archiveHousehold(user, household.id, {})
  assert.ok(archived.archivedAt, 'household archivedAt stamped')

  // Member profile is NOT cascaded — still active and readable.
  const memberDetail = store.getProfileDetail(user, primary.id)
  assert.equal(memberDetail.profile.archivedAt ?? null, null, 'member profile not cascaded')

  assert.equal(store.listHouseholds(user).length, 0, 'archived household hidden by default')
  assert.equal(store.listHouseholds(user, { includeArchived: true }).length, 1, 'includeArchived opts back in')
  assert.equal(store.getDashboard(user).stats.households, 0, 'dashboard household count drops')

  const auditArchived = store.listAudit(user).find((event) => event.action === 'household.archived')
  assert.ok(auditArchived, 'household.archived audit event written')

  const restored = store.restoreHousehold(user, household.id)
  assert.equal(restored.archivedAt, null)
  assert.equal(store.listHouseholds(user).length, 1, 'restored household re-appears')
})
