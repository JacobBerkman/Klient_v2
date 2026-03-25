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
  const dashboard = store.getDashboard(user)
  dashboard.firm.stageConfig = {
    stages: [
      { id: 'lead', role: 'start', order: 1 },
      { id: 'proposal', order: 2 },
      { id: 'won', role: 'end', order: 3 }
    ],
    startStageId: 'lead',
    endStageId: 'won'
  }

  store.createProfile(user, { kind: 'prospect', firstName: 'Lee', lastName: 'One', stage: 'lead' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Lee', lastName: 'Two', stage: 'lead' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Pia', lastName: 'Proposal', stage: 'proposal' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Wes', lastName: 'Won', stage: 'won' })

  const snapshot = store.getAnalytics(user)

  assert.deepEqual(
    snapshot.funnel.slice(0, 3).map((entry) => entry.stage),
    ['lead', 'proposal', 'won']
  )
  assert.equal(snapshot.overallConversionRate, 0.5)
})

test('analytics maps unknown or missing stages into a predictable legacy bucket', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)
  const dashboard = store.getDashboard(user)
  dashboard.firm.stageConfig = {
    stages: [
      { id: 'lead', role: 'start', order: 1 },
      { id: 'won', role: 'end', order: 2 }
    ]
  }

  store.createProfile(user, { kind: 'prospect', firstName: 'Legacy', lastName: 'Known', stage: 'old_analysis' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Legacy', lastName: 'Missing' })

  const snapshot = store.getAnalytics(user)
  const legacyFunnel = snapshot.funnel.find((entry) => entry.stage === 'legacy_unassigned')

  assert.equal(legacyFunnel?.count, 2)
  assert.equal(snapshot.stageAging.legacy_unassigned?.count, 2)

  const csv = store.exportAnalyticsCsv(user)
  assert.match(csv, /funnel,legacy_unassigned,count,2/)
})
