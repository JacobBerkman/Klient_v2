import { assert, createTestContext } from './test-harness.mjs'
import { runExportWorkerTick } from './export-worker-tick.mjs'

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function runWorkerTick(context, envOverrides = {}) {
  return runExportWorkerTick({
    cwd: context.testCwd,
    env: {
      EXPORT_WORKER_POLL_MS: '25',
      EXPORT_WORKER_LEASE_MS: '450',
      EXPORT_WORKER_BATCH_SIZE: '25',
      ...envOverrides
    },
    expectedStatus: envOverrides.EXPORT_WORKER_CRASH_AFTER_LEASE === '1' ? 92 : 0
  })
}

async function waitForExportStatus(context, headers, exportIds, terminalStatuses, maxTicks = 60) {
  const targetIds = new Set(exportIds)
  let latest = []
  for (let tick = 0; tick < maxTicks; tick += 1) {
    runWorkerTick(context)
    latest = await context.request('/api/exports?sort=updatedAt_desc', { headers })
    const settled = latest.filter((entry) => targetIds.has(entry.id) && terminalStatuses.has(entry.status))
    if (settled.length === exportIds.length) return settled
    await wait(80)
  }
  return latest.filter((entry) => targetIds.has(entry.id))
}

async function main() {
  const context = await createTestContext('export-stress-hardening')

  try {
    await context.login()
    const headers = context.authHeaders()

    const profile = await context.request('/api/profiles', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'client', firstName: 'Stress', lastName: 'Export', email: `stress+${Date.now()}@example.com` })
    })
    const template = await context.request('/api/templates/auto-build', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Export Stress Template', fields: ['client.name'] })
    })
    await context.request(`/api/templates/${template.id}/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionBump: '1.0.0', changelog: 'Stress export publish' })
    })

    const formTemplate = await context.request('/api/forms/templates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Stress Intake', sections: [{ title: 'Input', fields: [{ key: 'goal', label: 'Goal', type: 'text' }] }] })
    })
    const submission = await context.request('/api/forms/submissions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientId: profile.id, templateId: formTemplate.id, status: 'submitted', data: { goal: 'Scale exports' } })
    })

    // multiple simultaneous exports
    const concurrent = []
    for (let index = 0; index < 12; index += 1) {
      const created = await context.request('/api/exports', {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: index % 3 === 0 ? 'xlsx' : 'pdf' })
      })
      concurrent.push(created.id)
    }
    const settledConcurrent = await waitForExportStatus(context, headers, concurrent, new Set(['completed']))
    assert(settledConcurrent.length === concurrent.length, 'All concurrent export jobs should complete.')
    assert(settledConcurrent.every((entry) => entry.artifactReady === true), 'All completed concurrent exports should be artifactReady.')

    // retry after transient failure
    const transient = await context.request('/api/exports', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        clientId: profile.id,
        submissionId: submission.id,
        templateId: template.id,
        type: 'pdf',
        metadata: { simulateFailuresRemaining: 1 },
        maxAttempts: 3
      })
    })
    const transientSettled = await waitForExportStatus(context, headers, [transient.id], new Set(['completed']))
    assert(transientSettled[0]?.status === 'completed', 'Transient failure export should complete after retry.')
    assert(Number(transientSettled[0]?.attempts || 0) >= 1, 'Transient failure export should record at least one failed attempt.')

    // stuck job recovery (worker crashes after lease, then subsequent worker recovers)
    const stuckCandidate = await context.request('/api/exports', {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientId: profile.id, submissionId: submission.id, templateId: template.id, type: 'pdf' })
    })
    runWorkerTick(context, { EXPORT_WORKER_CRASH_AFTER_LEASE: '1', EXPORT_WORKER_BATCH_SIZE: '1' })
    await wait(500)

    const recovered = await waitForExportStatus(context, headers, [stuckCandidate.id], new Set(['completed']))
    assert(recovered[0]?.status === 'completed', 'Stuck export should recover and complete on subsequent worker ticks.')

    const queueHealth = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })
    assert(Number(queueHealth?.queue?.stalled || 0) === 0, 'Queue stalled count should drain back to zero after recovery.')
  } finally {
    await context.shutdown()
  }
}

main().catch((error) => {
  console.error(`❌ integration-export-stress failed: ${error.message}`)
  process.exitCode = 1
})
