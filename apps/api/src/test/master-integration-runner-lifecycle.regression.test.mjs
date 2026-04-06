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

test('aggregate runner does not stall waiting on inherited stdio held by grandchildren', async () => {
  const fixturePath = resolve(testDir, 'fixtures/runner-lifecycle/exit-before-stdio-close-fixture.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: fixturePath,
    label: 'exit-before-stdio-close-fixture',
    stdio: 'inherit',
    timeoutMs: 1200,
    cwd: repoRoot
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 450, `expected to resolve from child exit without waiting on stdio close, got ${elapsed}ms`)
})

test('master integration aggregate completes end-to-end for export suite in artifact-style execution', async () => {
  const masterIntegrationPath = resolve(repoRoot, 'scripts/master-integration.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: masterIntegrationPath,
    label: 'master-integration-exports-only',
    stdio: 'inherit',
    timeoutMs: 180000,
    cwd: repoRoot,
    env: {
      ...process.env,
      INTEGRATION_SUITES: 'integration-exports.mjs'
    }
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 180000, `expected aggregate runner completion before timeout, got ${elapsed}ms`)
})
