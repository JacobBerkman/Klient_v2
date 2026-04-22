import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalizeChildEnv } from './process-lifecycle.mjs'

const workerScript = fileURLToPath(new URL('./export-worker.mjs', import.meta.url))

function outputTail(value) {
  const text = String(value || '')
  return text.length > 8000 ? text.slice(-8000) : text
}

export function runExportWorkerTick({
  cwd,
  env = {},
  label = 'export worker tick',
  expectedStatus = 0,
  timeoutMs = Number.parseInt(process.env.EXPORT_WORKER_TICK_TIMEOUT_MS || '30000', 10)
} = {}) {
  const result = spawnSync(process.execPath, [workerScript], {
    cwd: cwd || process.cwd(),
    env: normalizeChildEnv({
      ...process.env,
      EXPORT_WORKER_ONCE: '1',
      EXPORT_WORKER_POLL_MS: '25',
      EXPORT_WORKER_LEASE_MS: '5000',
      EXPORT_WORKER_BATCH_SIZE: '10',
      EXPORT_WORKER_ID: `tick-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      NODE_ENV: 'test',
      ALLOW_DEV_FALLBACK_APP_SECRET: 'true',
      ...env
    }),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  })

  if (result.error) {
    throw new Error(
      `${label} failed to execute: ${result.error.message}\nstdout:\n${outputTail(result.stdout)}\nstderr:\n${outputTail(
        result.stderr
      )}`
    )
  }
  if (result.signal) {
    throw new Error(
      `${label} terminated by signal ${result.signal}\nstdout:\n${outputTail(result.stdout)}\nstderr:\n${outputTail(
        result.stderr
      )}`
    )
  }
  if (result.status !== expectedStatus) {
    throw new Error(
      `${label} exited with ${result.status}; expected ${expectedStatus}\nstdout:\n${outputTail(
        result.stdout
      )}\nstderr:\n${outputTail(result.stderr)}`
    )
  }
  return result.stdout
}
