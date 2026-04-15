import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const releaseEvidenceRoot = resolve(__dirname, '../../..', 'artifacts/release-evidence')
const lastReleaseValidationCache = {
  value: null,
  expiresAt: 0
}

function normalizeStatusKey(status) {
  return String(status || '').toLowerCase()
}

export function summarizeExportQueue(queue = {}) {
  const byStatus = queue?.byStatus || {}
  return {
    queued: Number(queue.queued ?? byStatus.queued ?? 0) + Number(byStatus.retrying ?? 0),
    active: Number(queue.running ?? byStatus.running ?? queue.processing ?? 0),
    failed: Number(queue.failed ?? byStatus.failed ?? 0) + Number(queue.deadLetter ?? byStatus['dead-letter'] ?? 0)
  }
}

export function classifyWorkerHealth(queue = {}) {
  const stalled = Number(queue?.stalled || 0)
  const running = Number(queue?.running ?? queue?.processing ?? queue?.byStatus?.running ?? 0)
  if (stalled > 0) return 'stalled'
  if (running > 0) return 'running'
  return 'idle'
}

export function pickRecentExportFailures(jobs = [], limit = 5) {
  return jobs
    .filter((entry) => ['failed', 'dead-letter', 'retrying'].includes(normalizeStatusKey(entry?.status)))
    .sort((a, b) => Number(new Date(b?.updatedAt || 0)) - Number(new Date(a?.updatedAt || 0)))
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      status: entry.status,
      failureReason: entry.failureReason || entry.errorMessage || entry.failure?.lastError || null,
      attempts: Number(entry.attempts || 0),
      updatedAt: entry.updatedAt || null
    }))
}

export function logOperationalEvent(log, level, eventType, fields = {}) {
  const metadata = {
    type: eventType,
    entity: fields.entity || 'system',
    id: fields.id || null,
    status: fields.status || null
  }
  if (fields.requestId) metadata.requestId = fields.requestId
  if (fields.firmId) metadata.firmId = fields.firmId
  if (fields.userId) metadata.userId = fields.userId
  if (fields.details && typeof fields.details === 'object') metadata.details = fields.details
  log(level, 'operational.event', metadata)
}

export async function readLastSuccessfulReleaseValidationTimestamp({ now = Date.now() } = {}) {
  if (lastReleaseValidationCache.expiresAt > now) return lastReleaseValidationCache.value

  let latestTimestamp = null
  try {
    const entries = await readdir(releaseEvidenceRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidatePath = resolve(releaseEvidenceRoot, entry.name, 'validate-master-summary.json')
      try {
        const raw = await readFile(candidatePath, 'utf8')
        const summary = JSON.parse(raw)
        if (String(summary?.status || '').toLowerCase() !== 'passed') continue
        const finishedAt = summary?.finishedAt || summary?.generatedAt || null
        if (!finishedAt) continue
        if (!latestTimestamp || Number(new Date(finishedAt)) > Number(new Date(latestTimestamp))) {
          latestTimestamp = finishedAt
        }
      } catch {
        // Ignore malformed or missing per-release summary files.
      }
    }
  } catch {
    latestTimestamp = null
  }

  lastReleaseValidationCache.value = latestTimestamp
  lastReleaseValidationCache.expiresAt = now + 60_000
  return latestTimestamp
}
