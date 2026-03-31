import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')
const { runChildProcess } = await import(pathToFileURL(resolve(repoRoot, 'scripts/runner-lifecycle.mjs')).href)

test('aggregate runner resolves only after child process lifecycle completes', async () => {
  const fixturePath = resolve(testDir, 'fixtures/runner-lifecycle/lifecycle-fixture.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: fixturePath,
    label: 'lifecycle-fixture',
    stdio: 'pipe',
    timeoutMs: 1200,
    cwd: repoRoot
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 1200, `expected completion before timeout, got ${elapsed}ms`)
  assert(elapsed >= 70, `expected process to wait for child shutdown, got ${elapsed}ms`)
})

test('aggregate runner rejects deterministically for failing child script', async () => {
  const failingFixturePath = resolve(testDir, 'fixtures/runner-lifecycle/failing-fixture.mjs')

  await assert.rejects(
    () =>
      runChildProcess({
        scriptPath: failingFixturePath,
        label: 'failing-fixture',
        stdio: 'pipe',
        timeoutMs: 1200,
        cwd: repoRoot
      }),
    /exited with code 7/
  )
})
