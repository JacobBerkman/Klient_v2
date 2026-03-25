import { spawn } from 'node:child_process'
import { assert, createTestContext } from './test-harness.mjs'

function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/export-worker.mjs'], {
      env: { ...process.env, EXPORT_WORKER_ONCE: '1', EXPORT_WORKER_BATCH_SIZE: '10', EXPORT_WORKER_POLL_MS: '50' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exit code ${code}: ${stderr}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function runWorkerCrashAfterLease(leaseMs = 250) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/export-worker.mjs'], {
      env: {
        ...process.env,
        EXPORT_WORKER_ONCE: '1',
        EXPORT_WORKER_CRASH_AFTER_LEASE: '1',
        EXPORT_WORKER_BATCH_SIZE: '1',
        EXPORT_WORKER_LEASE_MS: String(leaseMs)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const context = await createTestContext('exports')

try {
  const admin = await context.login()
  const headers = context.authHeaders(admin.token)

  const profile = await context.request('/api/profiles', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'client',
      firstName: 'Export',
      lastName: 'Client',
      email: `export.client+${Date.now()}@example.com`
    })
  })
  const template = await context.request('/api/templates/auto-build', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Export Template', fields: ['client.name', 'client.email'] })
  })
  await context.request(`/api/templates/${template.id}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}` }
  })

  const completedJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  const duplicateA = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `idem-${Date.now()}` },
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })
  const duplicateB = await context.request('/api/exports', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': duplicateA.idempotencyKey },
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  const flakyJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: template.id,
      type: 'pdf',
      metadata: { simulateFailuresRemaining: 1 },
      maxAttempts: 3
    })
  })

  const poisonJob = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clientId: profile.id,
      templateId: template.id,
      type: 'pdf',
      metadata: { simulateFailuresRemaining: 9 },
      maxAttempts: 8
    })
  })

  const crashRecovery = await context.request('/api/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: profile.id, templateId: template.id, type: 'pdf' })
  })

  const crashExit = await runWorkerCrashAfterLease(200)
  assert(crashExit.code === 92, 'Expected crash-recovery worker to terminate after leasing')
  await wait(260)
  await runWorkerOnce()
  await context.shutdown()

  const restartContext = await createTestContext('exports-restart')
  const restartAdmin = await restartContext.login()
  await runWorkerOnce()
  const exportsList = await restartContext.request('/api/exports', {
    headers: { Authorization: `Bearer ${restartAdmin.token}` }
  })
  const diagnostics = await restartContext.request('/api/ops/diagnostics', {
    headers: { Authorization: `Bearer ${restartAdmin.token}` }
  })

  const completed = exportsList.find((entry) => entry.id === completedJob.id)
  const duplicate = exportsList.find((entry) => entry.id === duplicateA.id)
  const flaky = exportsList.find((entry) => entry.id === flakyJob.id)
  const poison = exportsList.find((entry) => entry.id === poisonJob.id)
  const recovered = exportsList.find((entry) => entry.id === crashRecovery.id)
  assert(completed?.status === 'completed', 'Expected queued export processing to complete')
  assert(duplicateA.id === duplicateB.id, 'Expected duplicate create request to reuse idempotent export job')
  assert(duplicate?.status === 'completed', 'Expected idempotent duplicate job to complete once')
  assert(flaky?.status === 'completed', 'Expected retrying export to complete after worker restart')
  assert((flaky?.attempts || 0) >= 1, 'Expected retrying export attempts to increment')
  assert(poison?.status === 'dead_letter', 'Expected poison job to dead-letter')
  assert(
    poison?.failure?.reason === 'poison_job' || poison?.failure?.reason === 'max_attempts_exhausted',
    'Expected actionable dead-letter reason'
  )
  assert(recovered?.status === 'completed', 'Expected crash-recovery export to complete after lease timeout')
  assert(diagnostics?.data?.queue?.activeLeases >= 0, 'Expected queue lease diagnostics')
  assert(typeof diagnostics?.data?.queue?.readyNow === 'number', 'Expected queue ready-now diagnostics')
  assert(typeof diagnostics?.data?.queue?.stalled === 'number', 'Expected queue stalled diagnostics')

  console.log(
    JSON.stringify(
      {
        suite: 'integration-exports',
        completedId: completedJob.id,
        duplicateId: duplicateA.id,
        flakyId: flakyJob.id,
        flakyAttempts: flaky.attempts,
        poisonStatus: poison?.status,
        recoveredId: recovered?.id,
        queue: diagnostics?.data?.queue || null
      },
      null,
      2
    )
  )
  await restartContext.shutdown()
} finally {
  await context.shutdown()
}
