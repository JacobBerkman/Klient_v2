import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore({ legacyState } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-pipeline-stage-config-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-stage-config'
    if (legacyState) {
      const storageUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href
      const storage = await import(`${storageUrl}?t=${Date.now()}-${Math.random()}`)
      storage.saveState(legacyState)
    }
    const storeUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href
    const mod = await import(`${storeUrl}?t=${Date.now()}-${Math.random()}`)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store, firmName = 'Stage Config Firm') {
  const session = store.register({
    firmName,
    firstName: 'Taylor',
    lastName: 'Advisor',
    email: `advisor-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'PipelineSecure123!'
  })
  return store.requireUser(session.token)
}

function requireStageConfigApi(store, t) {
  const requiredMethods = [
    'listPipelineStages',
    'createPipelineStage',
    'deactivatePipelineStage',
    'reorderPipelineStages'
  ]
  const missing = requiredMethods.filter((name) => typeof store[name] !== 'function')
  if (missing.length) {
    t.skip(`stage-config APIs are unavailable in this branch: ${missing.join(', ')}`)
    return false
  }
  return true
}

test('legacy state without stage config migrates to default stage definitions', async (t) => {
  const store = await loadStore({
    legacyState: {
      firms: [],
      users: [],
      sessions: [],
      profiles: [],
      households: [],
      householdMembers: [],
      stageChanges: [],
      auditEvents: [],
      formTemplates: [],
      formSubmissions: [],
      documentTemplates: [],
      templateAggregates: [],
      exportJobs: [],
      documentUploads: [],
      pendingUploadIntents: [],
      draftStepStates: [],
      notes: [],
      invites: [],
      passwordResets: [],
      portalLinks: [],
      authAttempts: [],
      boardVersions: {}
    }
  })

  if (!requireStageConfigApi(store, t)) return

  const advisor = createAdvisor(store)
  // listPipelineStages returns { stages: [...] } now, not a bare array.
  const { stages } = store.listPipelineStages(advisor)

  assert.ok(Array.isArray(stages))
  assert.ok(stages.length > 0)
  assert.equal(stages[0].key, 'discovery')
})

test('firms maintain isolated stage definitions', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const alpha = createAdvisor(store, 'Alpha Advisors')
  const beta = createAdvisor(store, 'Beta Advisors')

  // createPipelineStage takes { key, label } (snake_case key, no orderIndex)
  // and returns the created stage record.
  const created = store.createPipelineStage(alpha, { key: 'estate_planning', label: 'Estate Planning' })
  const { stages: alphaStages } = store.listPipelineStages(alpha)
  const { stages: betaStages } = store.listPipelineStages(beta)

  assert.ok(alphaStages.some((stage) => stage.key === created.key))
  assert.ok(!betaStages.some((stage) => stage.key === created.key))
})

test('invalid stage assignment and stage reorder requests are rejected', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const advisor = createAdvisor(store)
  const profile = store.createProfile(advisor, {
    kind: 'prospect',
    firstName: 'Invalid',
    lastName: 'Move',
    stage: 'discovery'
  })

  assert.throws(() => {
    store.moveProfileStage(advisor, profile.id, '__missing_stage__')
  })

  // reorderPipelineStages requires { stageIds } covering every stage id for the
  // firm exactly once; a bogus/partial id list must be rejected.
  assert.throws(() => {
    store.reorderPipelineStages(advisor, { stageIds: ['__missing_stage__'] })
  })
})

test('reorder normalization works for non-default custom stage sequences', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const advisor = createAdvisor(store)
  const customA = store.createPipelineStage(advisor, { key: 'estate_planning', label: 'Estate Planning' })
  const customB = store.createPipelineStage(advisor, { key: 'tax_review', label: 'Tax Review' })

  // reorderPipelineStages consumes stage ids (not keys) and must list every
  // stage id for the firm exactly once. Build the desired prefix ordering and
  // append the remaining stage ids in their current order.
  const { stages: before } = store.listPipelineStages(advisor)
  const idByKey = new Map(before.map((stage) => [stage.key, stage.id]))
  const expectedPrefix = [customB.key, 'discovery', customA.key, 'analysis']
  const prefixIds = expectedPrefix.map((key) => idByKey.get(key))
  const remainingIds = before.map((stage) => stage.id).filter((id) => !prefixIds.includes(id))

  store.reorderPipelineStages(advisor, { stageIds: [...prefixIds, ...remainingIds] })

  const { stages: reordered } = store.listPipelineStages(advisor)
  const keys = reordered.map((stage) => stage.key)

  assert.deepEqual(keys.slice(0, expectedPrefix.length), expectedPrefix)
  const orderValues = reordered.map((stage) => stage.order)
  assert.deepEqual(orderValues, [...orderValues].sort((a, b) => a - b))
  // Order values are normalized to a contiguous 1..N sequence after reorder.
  assert.deepEqual(
    orderValues,
    Array.from({ length: reordered.length }, (_, index) => index + 1)
  )
})

test('pipeline + stage config flow: create/deactivate/reorder stages then move cards', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const advisor = createAdvisor(store)
  const planning = store.createPipelineStage(advisor, { key: 'planning_session', label: 'Planning Session' })
  const review = store.createPipelineStage(advisor, { key: 'annual_review', label: 'Annual Review' })

  const card = store.createProfile(advisor, {
    kind: 'prospect',
    firstName: 'Pat',
    lastName: 'Prospect',
    stage: 'discovery'
  })

  // Reorder via stage ids covering every stage exactly once (prefix + rest).
  const { stages: before } = store.listPipelineStages(advisor)
  const idByKey = new Map(before.map((stage) => [stage.key, stage.id]))
  const prefixIds = [planning.key, 'discovery', review.key, 'analysis'].map((key) => idByKey.get(key))
  const remainingIds = before.map((stage) => stage.id).filter((id) => !prefixIds.includes(id))
  store.reorderPipelineStages(advisor, { stageIds: [...prefixIds, ...remainingIds] })

  // moveProfileStage takes a stage KEY; the result carries the moved profile.
  const moved = store.moveProfileStage(advisor, card.id, planning.key)
  assert.equal(moved.stage || moved.moved?.stage, planning.key)

  // deactivatePipelineStage takes a stage ID (not a key).
  store.deactivatePipelineStage(advisor, review.id)

  assert.throws(() => {
    store.moveProfileStage(advisor, card.id, review.key)
  })

  const board = store.getBoard(advisor)
  assert.ok(Array.isArray(board.columns))
  assert.ok(board.columns.every((column) => Array.isArray(column.cards)))
})

test('the last active stage cannot be deactivated', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return
  const advisor = createAdvisor(store, 'Last Stage Firm')

  // Deactivate every stage but one. The UI disables the final button, but the
  // API is what has to hold: with zero active stages getDefaultProspectStage
  // throws and the firm can no longer create a prospect or move a card.
  const activeStages = () =>
    store.listPipelineStages(advisor).stages.filter((stage) => stage.isActive !== false)

  const stages = activeStages()
  assert.ok(stages.length > 1, 'fixture starts with several active stages')
  for (const stage of stages.slice(0, -1)) {
    store.deactivatePipelineStage(advisor, stage.id)
  }

  const [survivor] = activeStages()
  assert.ok(survivor, 'exactly one active stage remains')

  assert.throws(
    () => store.deactivatePipelineStage(advisor, survivor.id),
    (error) => {
      assert.equal(error.code, 'PIPELINE_LAST_ACTIVE_STAGE')
      assert.equal(error.statusCode, 409)
      return true
    }
  )

  // The board still works: the surviving stage is intact and usable.
  assert.equal(activeStages().length, 1)
  const prospect = store.createProfile(advisor, {
    kind: 'prospect',
    firstName: 'Still',
    lastName: 'Works',
    email: `last-stage-${Date.now()}@example.test`
  })
  assert.equal(prospect.stage, survivor.key, 'prospects can still be placed on the board')
})
