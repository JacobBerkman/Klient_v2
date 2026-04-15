import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

async function withTempEvidenceDir(prefix, fn) {
  const root = await mkdtemp(resolve(tmpdir(), prefix))
  const evidenceDir = resolve(root, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  try {
    await fn({ root, evidenceDir, evidenceFile: resolve(evidenceDir, 'validate-master-summary.json') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('validate:master finalizes summary after step timeout failure', async () => {
  await withTempEvidenceDir('validate-master-timeout-', async ({ evidenceDir, evidenceFile }) => {
    const result = spawnSync(process.execPath, ['scripts/master-validate.mjs'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_EVIDENCE_DIR: evidenceDir,
        VALIDATE_MASTER_STEPS: 'aggregate-handoff-regression',
        VALIDATE_MASTER_HANDOFF_TIMEOUT_MS: '1'
      }
    })

    assert.notEqual(result.status, 0, 'validate:master unexpectedly passed timeout scenario')
    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.failedStep, 'Aggregate handoff regression')
    assert.equal(typeof summary.finishedAt, 'string')
    assert.equal(typeof summary.durationMs, 'number')
    assert.equal(summary.error !== null, true)
    assert.equal(summary.steps[0]?.status, 'failed')
  })
})

test('validate:master finalizes summary when interrupted by SIGTERM', async () => {
  await withTempEvidenceDir('validate-master-sigterm-', async ({ evidenceDir, evidenceFile }) => {
    const child = spawn(process.execPath, ['scripts/master-validate.mjs'], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: {
        ...process.env,
        RELEASE_EVIDENCE_DIR: evidenceDir,
        VALIDATE_MASTER_STEPS: 'integration-suites',
        INTEGRATION_SUITES: 'integration-exports.mjs'
      }
    })

    const waitForRunningSummary = async () => {
      const timeoutAt = Date.now() + 5000
      while (Date.now() < timeoutAt) {
        try {
          await stat(evidenceFile)
          return
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25))
        }
      }
      throw new Error('validate:master did not create evidence summary before SIGTERM')
    }

    await waitForRunningSummary()
    const killed = child.kill('SIGTERM')
    assert.equal(killed, true, 'expected master-validate child process to still be running for SIGTERM test')

    await new Promise((resolveWait, reject) => {
      child.once('exit', resolveWait)
      child.once('error', reject)
    })

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.failedStep, 'Integration suites')
    assert.equal(typeof summary.finishedAt, 'string')
    assert.equal(typeof summary.durationMs, 'number')
    assert.match(String(summary.error?.message || ''), /SIGTERM/)
    assert.notEqual(summary.steps[0]?.status, 'pending')
  })
})

test('validate:master clears stale gate evidence files even when step filter excludes them', async () => {
  await withTempEvidenceDir('validate-master-stale-', async ({ evidenceDir }) => {
    const staleFiles = [
      resolve(evidenceDir, 'e2e-summary.json'),
      resolve(evidenceDir, 'security-summary.json'),
      resolve(evidenceDir, 'playwright-report.json')
    ]

    for (const staleFile of staleFiles) {
      await writeFile(staleFile, '{"status":"passed","stale":true}\n', 'utf8')
    }

    const result = spawnSync(process.execPath, ['scripts/master-validate.mjs'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_EVIDENCE_DIR: evidenceDir,
        VALIDATE_MASTER_STEPS: 'static-syntax-checks'
      }
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)

    for (const staleFile of staleFiles) {
      await assert.rejects(readFile(staleFile, 'utf8'))
    }
  })
})
