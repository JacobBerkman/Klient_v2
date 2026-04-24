import { runExportWorkerTick } from './export-worker-tick.mjs'

export const EXPORT_TEST_WORKER_ENV = Object.freeze({
  EXPORT_WORKER_POLL_MS: '25',
  EXPORT_WORKER_LEASE_MS: '5000',
  EXPORT_WORKER_BATCH_SIZE: '10'
})

export const EXPORT_TEST_POLL_DELAY_MS = Number.parseInt(process.env.EXPORT_TEST_POLL_DELAY_MS || '125', 10)
export const EXPORT_TEST_MAX_TICKS = Number.parseInt(process.env.EXPORT_TEST_MAX_TICKS || '60', 10)
export const DEFAULT_EXPORT_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'dead-letter'])

export function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

export function buildExportWorkerEnv(overrides = {}) {
  return {
    ...EXPORT_TEST_WORKER_ENV,
    ...overrides
  }
}

export function logSuiteStep(suite, step, details = {}) {
  console.log(
    JSON.stringify({
      type: 'suite-progress',
      suite,
      step,
      ...details
    })
  )
}

export function runSuiteWorkerTick(
  context,
  { suite, step = 'export worker tick', envOverrides = {}, expectedStatus = 0, label = step } = {}
) {
  logSuiteStep(suite, step)
  return runExportWorkerTick({
    cwd: context.testCwd,
    env: buildExportWorkerEnv(envOverrides),
    expectedStatus,
    label
  })
}

export async function captureExportDiagnostics({ suite, currentStep, context, headers, includeOps = true } = {}) {
  const snapshot = {
    suite,
    step: currentStep
  }
  if (!context) return snapshot

  try {
    snapshot.serverStatus = context.serverStatus?.() || null
  } catch (error) {
    snapshot.serverStatusError = error?.message || String(error)
  }

  try {
    snapshot.portOwnership = (await context.portOwnershipSnapshot?.()) || null
  } catch (error) {
    snapshot.portOwnershipError = error?.message || String(error)
  }

  if (!headers) return snapshot

  try {
    snapshot.exports = await context.request('/api/exports?sort=updatedAt_desc', { headers })
  } catch (error) {
    snapshot.exportsError = error?.message || String(error)
  }

  if (!includeOps) return snapshot

  try {
    snapshot.queue = await context.request('/api/ops/exports/queue', { headers: context.opsHeaders() })
  } catch (error) {
    snapshot.queueError = error?.message || String(error)
  }

  try {
    snapshot.diagnostics = await context.request('/api/ops/diagnostics', { headers: context.opsHeaders() })
  } catch (error) {
    snapshot.diagnosticsError = error?.message || String(error)
  }

  return snapshot
}

export async function waitForExportIds(
  context,
  {
    suite,
    headers,
    exportIds,
    currentStepPrefix = 'export completion polling',
    runWorkerTick,
    terminalStatuses = DEFAULT_EXPORT_TERMINAL_STATUSES,
    maxTicks = EXPORT_TEST_MAX_TICKS,
    pollDelayMs = EXPORT_TEST_POLL_DELAY_MS
  }
) {
  const remaining = new Set(exportIds)
  const terminalSet = new Set(terminalStatuses)
  let latest = []

  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    const tickNumber = attempt + 1
    logSuiteStep(suite, `${currentStepPrefix} tick`, { tick: tickNumber, remaining: remaining.size })
    runWorkerTick?.()
    latest = await context.request('/api/exports?sort=updatedAt_desc', { headers })
    for (const entry of latest) {
      if (!remaining.has(entry.id)) continue
      if (terminalSet.has(entry.status)) {
        remaining.delete(entry.id)
      }
    }
    if (remaining.size === 0) {
      return latest.filter((entry) => exportIds.includes(entry.id))
    }
    await wait(pollDelayMs)
  }

  return latest.filter((entry) => exportIds.includes(entry.id))
}
