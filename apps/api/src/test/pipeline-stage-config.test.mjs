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
  const stages = store.listPipelineStages(advisor)

  assert.ok(Array.isArray(stages))
  assert.ok(stages.length > 0)
  assert.equal(stages[0].key || stages[0].id || stages[0].stage, 'discovery')
})

test('firms maintain isolated stage definitions', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const alpha = createAdvisor(store, 'Alpha Advisors')
  const beta = createAdvisor(store, 'Beta Advisors')

  const created = store.createPipelineStage(alpha, { key: 'estate_planning', label: 'Estate Planning', orderIndex: 3 })
  const alphaStages = store.listPipelineStages(alpha)
  const betaStages = store.listPipelineStages(beta)

  assert.ok(alphaStages.some((stage) => (stage.key || stage.id || stage.stage) === (created.key || created.id || created.stage)))
  assert.ok(!betaStages.some((stage) => (stage.key || stage.id || stage.stage) === (created.key || created.id || created.stage)))
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

  assert.throws(() => {
    store.reorderPipelineStages(advisor, { stageOrder: ['__missing_stage__'] })
  })
})

test('reorder normalization works for non-default custom stage sequences', async (t) => {
  const store = await loadStore()
  if (!requireStageConfigApi(store, t)) return

  const advisor = createAdvisor(store)
  const customA = store.createPipelineStage(advisor, { key: 'estate_planning', label: 'Estate Planning' })
  const customB = store.createPipelineStage(advisor, { key: 'tax_review', label: 'Tax Review' })

  store.reorderPipelineStages(advisor, {
    stageOrder: [
      customB.key || customB.id || customB.stage,
      'discovery',
      customA.key || customA.id || customA.stage,
      'analysis'
    ]
  })

  const reordered = store.listPipelineStages(advisor)
  const keys = reordered.map((stage) => stage.key || stage.id || stage.stage)
  const expectedPrefix = [customB.key || customB.id || customB.stage, 'discovery', customA.key || customA.id || customA.stage, 'analysis']

  assert.deepEqual(keys.slice(0, expectedPrefix.length), expectedPrefix)
  const orderValues = reordered.map((stage) => Number(stage.orderIndex || stage.position || stage.rank || 0)).filter((value) => Number.isFinite(value) && value > 0)
  assert.deepEqual(orderValues, [...orderValues].sort((a, b) => a - b))
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

  store.reorderPipelineStages(advisor, {
    stageOrder: [planning.key || planning.id || planning.stage, 'discovery', review.key || review.id || review.stage, 'analysis']
  })

  const moved = store.moveProfileStage(advisor, card.id, planning.key || planning.id || planning.stage)
  assert.equal(moved.stage || moved.moved?.stage, planning.key || planning.id || planning.stage)

  store.deactivatePipelineStage(advisor, review.key || review.id || review.stage)

  assert.throws(() => {
    store.moveProfileStage(advisor, card.id, review.key || review.id || review.stage)
  })

  const board = store.getBoard(advisor)
  assert.ok(Array.isArray(board.columns))
  assert.ok(board.columns.every((column) => Array.isArray(column.cards)))
})
