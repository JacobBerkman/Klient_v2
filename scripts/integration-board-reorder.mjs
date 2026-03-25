import { assert, createTestContext } from './test-harness.mjs'

const context = await createTestContext('board-reorder')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const first = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Board',
      lastName: 'First',
      email: `board.first+${Date.now()}@example.com`,
      stage: 'analysis'
    })
  })
  const second = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Board',
      lastName: 'Second',
      email: `board.second+${Date.now()}@example.com`,
      stage: 'analysis'
    })
  })
  const third = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'prospect',
      firstName: 'Board',
      lastName: 'Third',
      email: `board.third+${Date.now()}@example.com`,
      stage: 'discovery'
    })
  })

  const initialBoard = await context.request('/api/board', { headers: { Authorization: `Bearer ${admin.token}` } })
  const moved = await context.request('/api/pipeline/reorder', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      profileId: third.id,
      toStage: 'analysis',
      beforeProfileId: second.id,
      expectedVersion: third.pipelineVersion,
      expectedUpdatedAt: third.updatedAt,
      expectedBoardVersion: initialBoard.boardVersion
    })
  })
  const boardAfterRefresh = await context.request('/api/board', { headers: { Authorization: `Bearer ${admin.token}` } })

  const analysis = boardAfterRefresh.columns.find((column) => column.stage === 'analysis')
  assert(analysis, 'Missing analysis column')
  const ids = analysis.cards.map((card) => card.id)
  const movedIndex = ids.indexOf(third.id)
  const anchorIndex = ids.indexOf(second.id)
  assert(movedIndex >= 0 && anchorIndex >= 0 && movedIndex < anchorIndex, 'Moved card should remain before anchor')
  assert(analysis.cards[movedIndex].orderIndex === movedIndex + 1, 'orderIndex should persist after refresh')
  assert(analysis.cards[anchorIndex].orderIndex === anchorIndex + 1, 'anchor orderIndex should persist after refresh')
  assert(moved.board.boardVersion > initialBoard.boardVersion, 'Board version should increment after reorder')

  console.log(
    JSON.stringify(
      {
        suite: 'integration-board-reorder',
        boardVersion: moved.board.boardVersion,
        analysisOrder: analysis.cards.slice(0, 4).map((card) => ({
          id: card.id,
          orderIndex: card.orderIndex,
          stageOrderIndex: card.stageOrderIndex
        })),
        firstId: first.id
      },
      null,
      2
    )
  )
} finally {
  await context.shutdown()
}
