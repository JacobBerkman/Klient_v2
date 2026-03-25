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
    firmName: 'Analytics Stage Config Firm',
    firstName: 'Alex',
    lastName: 'Advisor',
    email: `alex-${Math.random().toString(16).slice(2)}@example.com`,
    password: 'AnalyticsSecure123!'
  })
  return store.requireUser(session.token)
}

test('analytics snapshot respects configured stage labels and ordering', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.__setPipelineStagesForTest(user.firmId, [
    { id: 'initial_contact', label: 'Initial Contact' },
    { id: 'deep_review', label: 'Deep Review' },
    { id: 'won', label: 'Won', isTerminal: true },
    { id: 'lost', label: 'Lost', isTerminal: true, isDrop: true }
  ])

  store.createProfile(user, { kind: 'prospect', firstName: 'One', lastName: 'Lead', stage: 'initial_contact' })
  store.createProfile(user, { kind: 'prospect', firstName: 'Two', lastName: 'Lead', stage: 'deep_review' })

  const summary = store.getAnalytics(user)

  assert.deepEqual(
    summary.stageMetadata.map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: 'initial_contact', label: 'Initial Contact' },
      { id: 'deep_review', label: 'Deep Review' },
      { id: 'won', label: 'Won' },
      { id: 'lost', label: 'Lost' }
    ]
  )
  assert.deepEqual(summary.funnel.map((entry) => entry.stageId), ['initial_contact', 'deep_review', 'won'])
  assert.ok(summary.funnel.every((entry) => entry.stageLabel))
  assert.deepEqual(summary.stageAgingOrdered.map((entry) => entry.stageId), ['initial_contact', 'deep_review', 'won', 'lost'])
  assert.ok(summary.stageAgingOrdered.every((entry) => entry.stageLabel))
})

test('conversion and aging metrics treat drop stages as terminal but excluded from funnel and bottlenecks', async () => {
  const store = await loadStore()
  const user = createAdvisor(store)

  store.__setPipelineStagesForTest(user.firmId, [
    { id: 'discovery', label: 'Discovery' },
    { id: 'proposal', label: 'Proposal' },
    { id: 'completed', label: 'Completed', isTerminal: true },
    { id: 'dropped', label: 'Dropped', isTerminal: true, isDrop: true }
  ])

  store.createProfile(user, { kind: 'prospect', firstName: 'A', lastName: 'One', stage: 'discovery' })
  store.createProfile(user, { kind: 'prospect', firstName: 'B', lastName: 'Two', stage: 'completed' })
  store.createProfile(user, { kind: 'prospect', firstName: 'C', lastName: 'Three', stage: 'dropped' })

  const summary = store.getAnalytics(user)

  assert.deepEqual(summary.funnel.map((entry) => entry.stageId), ['discovery', 'proposal', 'completed'])
  assert.equal(summary.stageAgingOrdered.find((entry) => entry.stageId === 'dropped')?.count, 1)
  assert.equal(summary.bottlenecks.some((entry) => entry.stageId === 'dropped'), false)
  assert.equal(summary.bottlenecks.some((entry) => entry.stageId === 'completed'), false)
  assert.equal(summary.overallConversionRate, 1)
})
