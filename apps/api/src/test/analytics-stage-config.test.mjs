import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()

async function loadStore() {
  const tempDir = mkdtempSync(join(tmpdir(), 'klient-analytics-stage-config-'))
  process.chdir(tempDir)
  try {
    process.env.APP_SECRET = 'test-secret-for-analytics-stage-config'
    const moduleUrl = pathToFileURL(resolve(repoRoot, 'apps/api/src/store.mjs')).href + `?t=${Date.now()}-${Math.random()}`
    const mod = await import(moduleUrl)
    return mod.createStore()
  } finally {
    process.chdir(repoRoot)
  }
}

function createAdvisor(store) {
  const session = store.register({
    firmName: 'Analytics Stage Firm',
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
  // persisted stageConfig (resolveFirmAnalyticsStages). There is no public API
  // to reshape a firm's analytics stage config, and mutating an in-memory
  // dashboard copy no longer persists (firm rows are relational). So we assert
  // against the firm's actual configured funnel: the ordering must match the
  // configured stage order, and overall conversion is endStageCount /
  // startStageCount. Derive start/mid/end from an initial (empty) snapshot.
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

test('analytics maps unknown or missing stages into a predictable legacy bucket', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  // A prospect's stage must be an ACTIVE pipeline stage, but the analytics
  // funnel is resolved from the firm's stageConfig (resolveFirmAnalyticsStages).
  // Custom pipeline stages created via createPipelineStage are active -- so
  // createProfile accepts them -- yet are absent from the analytics stageConfig,
  // so analytics must bucket them into legacy_unassigned. This is the supported
  // reproduction of the original "unknown / off-config stage" case.
  store.createPipelineStage(user, { key: 'old_analysis', label: 'Old Analysis' })
  store.createPipelineStage(user, { key: 'legacy_intake', label: 'Legacy Intake' })

  store.createProfile(user, { kind: 'prospect', firstName: 'Legacy', lastName: 'Known', stage: 'old_analysis' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Legacy', lastName: 'Missing', stage: 'legacy_intake' })

  const snapshot = store.getAnalytics(user)
  const legacyFunnel = snapshot.funnel.find((entry) => entry.stage === 'legacy_unassigned')

  assert.equal(legacyFunnel?.count, 2)
  assert.equal(snapshot.stageAging.legacy_unassigned?.count, 2)

  const csv = store.exportAnalyticsCsv(user)
  assert.match(csv, /funnel,legacy_unassigned,count,2/)
})
