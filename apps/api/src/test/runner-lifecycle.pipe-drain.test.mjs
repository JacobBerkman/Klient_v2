import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')
const { runChildProcess, runCommandProcess } = await import(pathToFileURL(resolve(repoRoot, 'scripts/runner-lifecycle.mjs')).href)

// Keep in sync with the close-fallback `setTimeout(..., 1000)` armed in
// scripts/runner-lifecycle.mjs (runCommandProcess). When a piped child emits
// `exit` before `close` — i.e. a descendant is still pinning the inherited
// stdout — the runner waits this grace period, then settles from the `exit`
// result rather than hanging on the never-arriving `close`.
const CLOSE_FALLBACK_MS = 1000

// The release gate runs with INTEGRATION_TIMEOUT_SCALE=3 on loaded Windows
// hosts; only the upper bound needs slack for scheduler jitter (the fallback
// grace itself is a fixed product constant and never fires early).
function resolveTimeoutScale() {
  const scale = Number.parseFloat(process.env.INTEGRATION_TIMEOUT_SCALE || '1')
  if (!Number.isFinite(scale) || scale < 1) return 1
  return Math.min(scale, 10)
}

test('aggregate runner drains piped stdio to avoid pipe-buffer deadlocks', async () => {
  const fixturePath = resolve(testDir, 'fixtures/runner-lifecycle/pipe-buffer-fixture.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: fixturePath,
    label: 'pipe-buffer-fixture',
    stdio: 'pipe',
    timeoutMs: 2000,
    cwd: repoRoot
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 2000, `expected piped output fixture completion before timeout, got ${elapsed}ms`)
})

test('aggregate runner settles from exit fallback when descendant keeps inherited stdout open', async () => {
  // A descendant that inherits the child's stdout can hold the pipe open so
  // `close` never arrives after the child `exit`s. Reproducing that with a real
  // spawn is OS-dependent (on Windows the pipe EOFs the moment the direct child
  // exits, so `close` fires immediately and the fallback never arms), so we
  // drive the exact condition deterministically: a stub child that emits `exit`
  // but never `close`. This forces the runner through its close-fallback grace.
  const timeoutScale = resolveTimeoutScale()
  const start = Date.now()
  // Ref'd timer keeps the loop alive across the (unref'd) fallback timer.
  const keepAlive = setInterval(() => {}, 250)

  let terminateCalls = 0
  let result
  try {
    result = await runCommandProcess({
      command: process.execPath,
      args: ['exit-before-stdio-close-stub'],
      label: 'pipe-descendant-open-descriptor',
      stdio: 'pipe',
      timeoutMs: 5000,
      startProcess: () => {
        const child = new EventEmitter()
        const stubStream = () => ({ destroyed: false, resume() {}, destroy() { this.destroyed = true } })
        child.stdout = stubStream()
        child.stderr = stubStream()
        child.pid = 424242
        // Exit cleanly, but never emit `close` — the descendant still pins stdout.
        setTimeout(() => child.emit('exit', 0, null), 10)
        return { child, label: 'pipe-descendant-open-descriptor', startedAt: Date.now() }
      },
      terminateProcess: async () => {
        terminateCalls += 1
        return { exited: true }
      },
      releaseStdio: () => {}
    })
  } finally {
    clearInterval(keepAlive)
  }

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  // Settled from the `exit` fallback, so the child was never force-terminated.
  assert.equal(terminateCalls, 0, 'expected exit fallback to settle without terminating the child')
  // Proves the runner honored the grace period instead of settling on `exit`.
  assert(
    elapsed >= CLOSE_FALLBACK_MS - 100,
    `expected close fallback grace (~${CLOSE_FALLBACK_MS}ms) before settling, got ${elapsed}ms`
  )
  // Proves it settled promptly after the grace rather than hanging on `close`.
  assert(
    elapsed < CLOSE_FALLBACK_MS + 2000 * timeoutScale,
    `expected exit fallback shortly after the grace, got ${elapsed}ms`
  )
})

test('aggregate runner does not timeout when child exits on timeout boundary', async () => {
  const scriptPath = resolve(testDir, 'fixtures/runner-lifecycle/lifecycle-fixture.mjs')
  const result = await runChildProcess({
    scriptPath,
    label: 'pipe-timeout-boundary',
    stdio: 'pipe',
    timeoutMs: 350,
    cwd: repoRoot
  })

  assert.equal(result.code, 0)
})
