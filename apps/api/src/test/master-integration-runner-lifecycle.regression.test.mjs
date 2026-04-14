import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, '../../../..')
const { runChildProcess, runCommandProcess } = await import(
  pathToFileURL(resolve(repoRoot, 'scripts/runner-lifecycle.mjs')).href
)

function listServerProcessIds(cwd = repoRoot) {
  const psOutput = execFileSync('ps', ['-eo', 'pid=,args='], { cwd, encoding: 'utf8' })
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes('apps/api/src/server.mjs') && line.includes(cwd))
    .map((line) => Number.parseInt(line.split(/\s+/, 1)[0], 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

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

test('integration aggregate leaves no orphaned API server handles after exports suite', { concurrency: false }, async () => {
  const before = listServerProcessIds()
  const start = Date.now()

  const result = await runCommandProcess({
    command: 'npm',
    args: ['run', 'test:integration'],
    label: 'npm-test-integration-exports-orphan-check',
    stdio: 'inherit',
    timeoutMs: 240000,
    cwd: repoRoot,
    env: {
      ...process.env,
      INTEGRATION_SUITES: 'integration-exports.mjs'
    }
  })

  const elapsed = Date.now() - start
  assert.equal(result.code, 0)
  assert(elapsed < 240000, `expected integration aggregate completion before timeout, got ${elapsed}ms`)

  // Allow the OS scheduler to flush process exit bookkeeping before snapshotting process table.
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))

  const after = listServerProcessIds()
  assert.deepEqual(after, before, `expected no orphaned API server process; before=${before.join(',')} after=${after.join(',')}`)
})

test('validate master runs integration and aggregate handoff regression from unpacked zip-style artifact', { concurrency: false }, async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-artifact-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')
  const evidenceDir = resolve(artifactRoot, 'release-evidence')
  const evidenceFile = resolve(evidenceDir, 'validate-master-summary.json')

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
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 300000,
      cwd: unpackedRoot,
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'integration-suites,aggregate-handoff-regression',
        INTEGRATION_SUITES: 'integration-templates.mjs,integration-exports.mjs',
        RELEASE_EVIDENCE_DIR: evidenceDir
      }
    })

    const elapsed = Date.now() - start
    assert.equal(result.code, 0)
    assert(elapsed < 300000, `expected artifact validate completion before timeout, got ${elapsed}ms`)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    const integrationStep = summary.steps.find((step) => step.key === 'integration-suites')
    const handoffStep = summary.steps.find((step) => step.key === 'aggregate-handoff-regression')
    assert.equal(integrationStep?.status, 'passed')
    assert.equal(handoffStep?.status, 'passed')
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('validate master allows E2E fallback in unpacked zip-style artifact flow when strict mode is not explicitly requested', { concurrency: false }, async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-artifact-e2e-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')
  const evidenceDir = resolve(artifactRoot, 'release-evidence')
  const evidenceFile = resolve(evidenceDir, 'validate-master-summary.json')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  try {
    const result = await runChildProcess({
      scriptPath: resolve(unpackedRoot, 'scripts/master-validate.mjs'),
      label: 'master-validate-unpacked-artifact-e2e-fallback',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 180000,
      cwd: unpackedRoot,
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'e2e-browser-checks',
        RELEASE_EVIDENCE_DIR: evidenceDir
      }
    })

    assert.equal(result.code, 0)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    const e2eStep = summary.steps.find((step) => step.key === 'e2e-browser-checks')
    assert.equal(e2eStep?.status, 'passed')
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('validate master includes aggregate handoff regression step and exits cleanly', { concurrency: false }, async () => {
  const evidenceRoot = await mkdtemp(resolve(tmpdir(), 'validate-master-handoff-'))
  const evidenceFile = resolve(evidenceRoot, 'validate-master-summary.json')
  const masterValidatePath = resolve(repoRoot, 'scripts/master-validate.mjs')
  const start = Date.now()

  try {
    const result = await runChildProcess({
      scriptPath: masterValidatePath,
      label: 'master-validate-integration-handoff-only',
      stdio: 'inherit',
      timeoutMs: 240000,
      cwd: repoRoot,
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'integration-suites,aggregate-handoff-regression',
        INTEGRATION_SUITES: 'integration-exports.mjs',
        RELEASE_EVIDENCE_FILE: evidenceFile
      }
    })

    const elapsed = Date.now() - start
    assert.equal(result.code, 0)
    assert(elapsed < 240000, `expected validate:master completion before timeout, got ${elapsed}ms`)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    const stepNames = summary.steps.map((step) => step.name)
    assert.deepEqual(stepNames, ['Integration suites', 'Aggregate handoff regression'])

    const handoffStep = summary.steps.find((step) => step.name === 'Aggregate handoff regression')
    assert.equal(handoffStep?.status, 'passed')
    assert.equal(typeof handoffStep?.durationMs, 'number')
    assert(handoffStep.durationMs >= 0, `expected non-negative step duration, got ${handoffStep.durationMs}`)
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true })
  }
})
