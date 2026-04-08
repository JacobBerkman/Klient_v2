import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')
const { runChildProcess, runCommandProcess } = await import(
  pathToFileURL(resolve(repoRoot, 'scripts/runner-lifecycle.mjs')).href
)

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


test('master integration aggregate completes with test-harness piped server stdio in artifact-style execution', { concurrency: false }, async () => {
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



test('master integration hands off cleanly from exports suite to subsequent suite in artifact-style flow', { concurrency: false }, async () => {
  const masterIntegrationPath = resolve(repoRoot, 'scripts/master-integration.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: masterIntegrationPath,
    label: 'master-integration-exports-handoff',
    stdio: 'inherit',
    timeoutMs: 240000,
    cwd: repoRoot,
    env: {
      ...process.env,
      INTEGRATION_SUITES: 'integration-exports.mjs,integration-portal-lifecycle.mjs'
    }
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 240000, `expected handoff after exports suite to complete before timeout, got ${elapsed}ms`)
})

test('npm test:integration exits cleanly when filtered to integration-exports suite', { concurrency: false }, async () => {
  const start = Date.now()
  const result = await runCommandProcess({
    command: 'npm',
    args: ['run', 'test:integration'],
    label: 'npm-test-integration-exports-only',
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
  assert(elapsed < 180000, `expected npm test:integration completion before timeout, got ${elapsed}ms`)
})

test('validate master exits cleanly after integration success in artifact-style flow', { concurrency: false }, async () => {
  const masterValidatePath = resolve(repoRoot, 'scripts/master-validate.mjs')
  const start = Date.now()

  const result = await runChildProcess({
    scriptPath: masterValidatePath,
    label: 'master-validate-integration-only',
    stdio: 'inherit',
    timeoutMs: 120000,
    cwd: repoRoot,
    env: {
      ...process.env,
      VALIDATE_MASTER_STEPS: 'integration-suites',
      INTEGRATION_SUITES: 'integration-exports.mjs'
    }
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 180000, `expected validate:master completion before timeout, got ${elapsed}ms`)
})

test('validate master skips merge parity and completes from unpacked zip-style artifact', { concurrency: false }, async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-artifact-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  const start = Date.now()
  try {
    const result = await runChildProcess({
      scriptPath: resolve(unpackedRoot, 'scripts/master-validate.mjs'),
      label: 'master-validate-unpacked-artifact',
      stdio: 'inherit',
      timeoutMs: 300000,
      cwd: unpackedRoot,
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'integration-suites',
        INTEGRATION_SUITES: 'integration-exports.mjs,integration-portal-lifecycle.mjs'
      }
    })

    const elapsed = Date.now() - start
    assert.equal(result.code, 0)
    assert(elapsed < 300000, `expected artifact validate completion before timeout, got ${elapsed}ms`)
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})
