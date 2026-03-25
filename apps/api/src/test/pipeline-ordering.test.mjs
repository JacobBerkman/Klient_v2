import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-pipeline-ordering-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-pipeline-ordering'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Pipeline Test Firm',
    firstName: 'Pat',
    lastName: 'Operator',
    email: `pat-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'PipelineSecure123!'
  })
  return store.requireUser(session.token)
}

test('board reorder supports cross-stage moves with deterministic index compaction', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const first = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'First',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  const second = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Second',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  const target = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Target',
    lastName: 'Analysis',
    stage: 'analysis'
  })
  const initialBoard = store.getBoard(user)

  const result = store.reorderBoard(user, {
    profileId: second.id,
    toStage: 'analysis',
    beforeProfileId: target.id,
    expectedVersion: second.pipelineVersion,
    expectedUpdatedAt: second.updatedAt,
    expectedBoardVersion: initialBoard.boardVersion
  })

  assert.equal(result.moved.stage, 'analysis')
  const board = result.board
  const analysis = board.columns.find((column) => column.stage === 'analysis')
  const discovery = board.columns.find((column) => column.stage === 'discovery')

  assert.deepEqual(
    analysis.cards.slice(0, 2).map((card) => card.id),
    [second.id, target.id]
  )
  assert.deepEqual(
    analysis.cards.slice(0, 2).map((card) => card.stageOrderIndex),
    [1, 2]
  )
  assert.deepEqual(
    analysis.cards.slice(0, 2).map((card) => card.orderIndex),
    [1, 2]
  )
  assert.equal(discovery.cards.find((card) => card.id === first.id)?.stageOrderIndex, 1)
  assert.equal(discovery.cards.find((card) => card.id === first.id)?.orderIndex, 1)
  assert.ok(board.boardVersion > initialBoard.boardVersion)
})

test('board reorder rejects stale optimistic concurrency tokens during concurrent drag simulations', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const card = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Concurrent',
    lastName: 'Card',
    stage: 'discovery'
  })
  const anchor = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Anchor',
    lastName: 'Card',
    stage: 'discovery'
  })
  const staleVersion = card.pipelineVersion
  const staleUpdatedAt = card.updatedAt

  const firstMove = store.reorderBoard(user, {
    profileId: card.id,
    toStage: 'discovery',
    beforeProfileId: anchor.id,
    expectedVersion: staleVersion,
    expectedUpdatedAt: staleUpdatedAt
  })

  assert.equal(firstMove.moved.pipelineVersion, staleVersion + 1)

  assert.throws(
    () => {
      store.reorderBoard(user, {
        profileId: card.id,
        toStage: 'analysis',
        expectedVersion: staleVersion,
        expectedUpdatedAt: staleUpdatedAt
      })
    },
    (error) => {
      assert.equal(error.code, 'PIPELINE_ORDER_CONFLICT')
      assert.equal(error.statusCode, 409)
      return true
    }
  )
})

test('pipeline reorder transaction rolls back index changes when persistence fails', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const movable = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Rollback',
    lastName: 'Source',
    stage: 'discovery'
  })
  const before = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Rollback',
    lastName: 'Anchor',
    stage: 'analysis'
  })
  const boardBefore = store.getBoard(user)

  store.__setTestHooks({
    beforePersist: () => {
      throw new Error('forced persist failure')
    }
  })

  assert.throws(() => {
    store.reorderBoard(user, {
      profileId: movable.id,
      toStage: 'analysis',
      beforeProfileId: before.id
    })
  }, /forced persist failure/)

  store.__clearTestHooks()

  const boardAfter = store.getBoard(user)
  const discoveryAfter = boardAfter.columns.find((column) => column.stage === 'discovery')
  const analysisAfter = boardAfter.columns.find((column) => column.stage === 'analysis')

  assert.ok(discoveryAfter.cards.some((card) => card.id === movable.id))
  assert.ok(!analysisAfter.cards.some((card) => card.id === movable.id))
  assert.equal(boardAfter.boardVersion, boardBefore.boardVersion)
})

test('board response remains backward compatible for legacy consumers', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Legacy',
    lastName: 'Consumer',
    stage: 'discovery'
  })

  const board = store.getBoard(user)

  assert.ok(Array.isArray(board.columns))
  assert.equal(typeof board.boardVersion, 'number')
  assert.equal(board.ordering?.mode, 'sequential_stage_index')

  const discovery = board.columns.find((column) => column.stage === 'discovery')
  assert.ok(discovery)
  assert.equal(Array.isArray(discovery.cards), true)
  if (discovery.cards.length > 0) {
    assert.equal(typeof discovery.cards[0].stageOrderIndex, 'number')
    assert.equal(typeof discovery.cards[0].orderIndex, 'number')
  }
})
