import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

// Importing storage.mjs at its canonical (non-cache-busted) URL returns the very
// same module instance store.mjs imported, so store writes and these read-backs
// share one node:sqlite connection — letting tests assert the persisted firm row
// (not just the in-memory copy) reflects stage-config changes.
async function loadStorage() {
  const storageUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/storage.mjs')).href
  return import(storageUrl)
}

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-analytics-stage-config-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-analytics-stage-config'
    const moduleUrl =
      pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store, firmName = 'Analytics Stage Firm') {
  const session = store.register({
    firmName,
    firstName: 'Ari',
    lastName: 'Advisor',
    email: `analytics-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'AnalyticsSecure123!'
  })
  return store.requireUser(session.token)
}

test('analytics funnel ordering and conversion follow tenant stage configuration', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  // The analytics funnel order + start/end stages are driven by the firm's
  // persisted stageConfig (resolveFirmAnalyticsStages). Derive start/mid/end from
  // an initial (empty) snapshot and assert conversion is endCount / startCount.
  const baseline = store.getAnalytics(user)
  const funnelOrder = baseline.funnel.map((entry) => entry.stage)
  const startStage = baseline.stageMetadata.find((stage) => stage.isStart).id
  const endStage = baseline.stageMetadata.find((stage) => stage.isTerminal).id
  const midStage = funnelOrder.find((stage) => stage !== startStage && stage !== endStage)

  // 2 in start, 1 in an intermediate stage, 1 in end -> conversion = 1/2 = 0.5.
  store.createProfile(user, { kind: 'prospect', firstName: 'Lee', lastName: 'One', stage: startStage })
  store.createProfile(user, { kind: 'prospect', firstName: 'Lee', lastName: 'Two', stage: startStage })
  store.createProfile(user, { kind: 'prospect', firstName: 'Pia', lastName: 'Proposal', stage: midStage })
  store.createProfile(user, { kind: 'prospect', firstName: 'Wes', lastName: 'Won', stage: endStage })

  const snapshot = store.getAnalytics(user)

  // Funnel ordering follows the tenant's configured stage order.
  assert.deepEqual(
    snapshot.funnel.map((entry) => entry.stage),
    funnelOrder
  )
  assert.equal(snapshot.overallConversionRate, 0.5)
})

test('creating a custom stage couples it into analytics: prospects surface there, not in legacy_unassigned', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  // Create a bespoke pipeline stage and move a prospect into it.
  const custom = store.createPipelineStage(user, { key: 'planning_session', label: 'Planning Session' })
  const prospect = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Pat',
    lastName: 'Prospect',
    stage: 'discovery'
  })
  store.moveProfileStage(user, prospect.id, custom.key)

  const snapshot = store.getAnalytics(user)

  // The custom stage appears as its own funnel entry with the moved prospect's
  // count -- NOT bucketed into legacy_unassigned (the decoupling bug).
  const funnelEntry = snapshot.funnel.find((entry) => entry.stage === 'planning_session')
  assert.equal(funnelEntry?.count, 1)
  assert.ok(
    !snapshot.funnel.some((entry) => entry.stage === 'legacy_unassigned'),
    'no legacy_unassigned funnel entry should exist for a coupled custom stage'
  )
  assert.equal(snapshot.stageAging.planning_session?.count, 1)
  assert.equal(snapshot.stageAging.legacy_unassigned, undefined)

  // stageMetadata carries the custom stage with its label.
  const meta = snapshot.stageMetadata.find((stage) => stage.id === 'planning_session')
  assert.equal(meta?.label, 'Planning Session')

  // The persisted firm row (read back through storage, not the in-memory copy)
  // reflects the coupled stage config.
  const storage = await loadStorage()
  const firmRow = storage.getFirmRow(user.firmId)
  assert.ok(
    firmRow.stageConfig.stages.some((stage) => stage.key === 'planning_session'),
    'firm row stageConfig must include the custom stage'
  )
})

test('renaming a stage updates the analytics label in the same persist cycle', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const custom = store.createPipelineStage(user, { key: 'annual_review', label: 'Annual Review' })
  const prospect = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Ren',
    lastName: 'Review',
    stage: 'discovery'
  })
  store.moveProfileStage(user, prospect.id, custom.key)

  const before = store.getAnalytics(user)
  assert.equal(before.stageMetadata.find((stage) => stage.id === 'annual_review')?.label, 'Annual Review')

  // updatePipelineStageMetadata takes the stage ID (not key).
  store.updatePipelineStageMetadata(user, custom.id, { label: 'Client Review' })

  const after = store.getAnalytics(user)
  assert.equal(after.stageMetadata.find((stage) => stage.id === 'annual_review')?.label, 'Client Review')
  assert.equal(after.stageAgingOrdered.find((entry) => entry.stageId === 'annual_review')?.stageLabel, 'Client Review')

  const storage = await loadStorage()
  const firmRow = storage.getFirmRow(user.firmId)
  assert.equal(
    firmRow.stageConfig.stages.find((stage) => stage.key === 'annual_review')?.label,
    'Client Review'
  )
})

test('reordering pipeline stages reorders the analytics funnel', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const planning = store.createPipelineStage(user, { key: 'planning_session', label: 'Planning Session' })
  const review = store.createPipelineStage(user, { key: 'annual_review', label: 'Annual Review' })

  // Move the two custom stages to the very front of the pipeline.
  const { stages: before } = store.listPipelineStages(user)
  const idByKey = new Map(before.map((stage) => [stage.key, stage.id]))
  const prefixIds = [review.key, planning.key].map((key) => idByKey.get(key))
  const remainingIds = before.map((stage) => stage.id).filter((id) => !prefixIds.includes(id))
  store.reorderPipelineStages(user, { stageIds: [...prefixIds, ...remainingIds] })

  const snapshot = store.getAnalytics(user)
  const funnelKeys = snapshot.funnel.map((entry) => entry.stage)
  assert.deepEqual(funnelKeys.slice(0, 2), ['annual_review', 'planning_session'])

  const storage = await loadStorage()
  const firmRow = storage.getFirmRow(user.firmId)
  assert.deepEqual(
    firmRow.stageConfig.stages.slice(0, 2).map((stage) => stage.key),
    ['annual_review', 'planning_session']
  )
})

test('deactivating a stage keeps its analytics counts instead of dumping to legacy_unassigned', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  const custom = store.createPipelineStage(user, { key: 'planning_session', label: 'Planning Session' })
  const prospect = store.createProfile(user, {
    kind: 'prospect',
    firstName: 'Dee',
    lastName: 'Active',
    stage: 'discovery'
  })
  store.moveProfileStage(user, prospect.id, custom.key)

  // Deactivate the stage while a prospect still sits in it.
  store.deactivatePipelineStage(user, custom.id)

  const snapshot = store.getAnalytics(user)

  // Documented choice: deactivated stages remain in analytics (active:false) with
  // their historical counts -- prospects are NOT dumped into legacy_unassigned.
  const funnelEntry = snapshot.funnel.find((entry) => entry.stage === 'planning_session')
  assert.equal(funnelEntry?.count, 1)
  assert.equal(snapshot.stageAging.planning_session?.count, 1)
  assert.equal(snapshot.stageAging.legacy_unassigned, undefined)

  const meta = snapshot.stageMetadata.find((stage) => stage.id === 'planning_session')
  assert.equal(meta?.active, false)

  const storage = await loadStorage()
  const firmRow = storage.getFirmRow(user.firmId)
  const persisted = firmRow.stageConfig.stages.find((stage) => stage.key === 'planning_session')
  assert.ok(persisted, 'deactivated stage must remain in the persisted stage config')
  assert.equal(persisted.active, false)
})

test('genuinely orphaned stages (pre-stage-management data) map into the legacy bucket', async () => {
  // A prospect whose stage predates stage management -- no matching stage record
  // and no config entry -- is the legitimate legacy case. The coupling only syncs
  // firm.stageConfig on stage mutations, so an orphan stage carried by a profile
  // (never a configured/record stage) must still fall into legacy_unassigned.
  // Insert such prospects straight into the relational profiles table (bypassing
  // createProfile's active-stage guard, which is exactly how pre-existing data
  // slips in).
  const store = await loadStore()
  const user = createAdvisor(store)
  const storage = await loadStorage()
  for (const suffix of ['1', '2']) {
    storage.upsertProfileRow({
      id: `prospect-orphan-${suffix}`,
      firmId: user.firmId,
      kind: 'prospect',
      firstName: 'Ancient',
      lastName: suffix,
      stage: 'ancient_intake',
      createdAt: `2024-02-0${suffix}T00:00:00.000Z`,
      updatedAt: `2024-02-0${suffix}T00:00:00.000Z`
    })
  }

  const snapshot = store.getAnalytics(user)
  const legacyFunnel = snapshot.funnel.find((entry) => entry.stage === 'legacy_unassigned')
  assert.equal(legacyFunnel?.count, 2)
  assert.equal(snapshot.stageAging.legacy_unassigned?.count, 2)

  const csv = store.exportAnalyticsCsv(user)
  assert.match(csv, /funnel,legacy_unassigned,count,2/)
})
