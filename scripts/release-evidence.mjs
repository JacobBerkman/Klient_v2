import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_DIR = 'artifacts/release-evidence'

function toIsoTimestamp(value = Date.now()) {
  return new Date(value).toISOString()
}

function resolveEvidenceFile(defaultFile, envVarName) {
  const explicitFile = envVarName ? process.env[envVarName] : ''
  if (explicitFile) {
    return resolve(process.cwd(), explicitFile)
  }
  return resolve(process.cwd(), DEFAULT_DIR, defaultFile)
}

export function createEvidenceRecorder({
  gate,
  defaultFile,
  envVarName,
  command,
  metadata = {}
}) {
  const startedAtMs = Date.now()
  const evidenceFile = resolveEvidenceFile(defaultFile, envVarName)
  const basePayload = {
    schemaVersion: '1.0.0',
    gate,
    command,
    startedAt: toIsoTimestamp(startedAtMs),
    finishedAt: null,
    durationMs: null,
    status: 'running',
    metadata
  }

  const persist = (payload) => {
    mkdirSync(dirname(evidenceFile), { recursive: true })
    writeFileSync(evidenceFile, JSON.stringify(payload, null, 2))
  }

  persist(basePayload)

  return {
    evidenceFile,
    finalize({ status, details = {}, error = null }) {
      const finishedAtMs = Date.now()
      const payload = {
        ...basePayload,
        status,
        finishedAt: toIsoTimestamp(finishedAtMs),
        durationMs: finishedAtMs - startedAtMs,
        details,
        error: error ? { message: String(error.message || error) } : null
      }
      persist(payload)
      return payload
    }
  }
}
