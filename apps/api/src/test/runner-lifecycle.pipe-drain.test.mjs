import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')
const { runChildProcess } = await import(pathToFileURL(resolve(repoRoot, 'scripts/runner-lifecycle.mjs')).href)

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
  const scriptPath = resolve(testDir, 'fixtures/runner-lifecycle/exit-before-stdio-close-fixture.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath,
    label: 'pipe-descendant-open-descriptor',
    stdio: 'pipe',
    timeoutMs: 5000,
    cwd: repoRoot
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed >= 600, `expected close fallback grace period before settling, got ${elapsed}ms`)
  assert(elapsed < 3000, `expected exit fallback without waiting for descendant lifetime, got ${elapsed}ms`)
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
