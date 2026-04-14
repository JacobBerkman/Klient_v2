import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

test('validate:master allows E2E fallback only in diagnostic_local mode', async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-validate-e2e-artifact-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')
  const evidenceDir = resolve(artifactRoot, 'evidence')
  const evidenceFile = resolve(evidenceDir, 'validate-master-summary.json')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  try {
    const result = spawnSync(process.execPath, ['scripts/master-validate.mjs'], {
      cwd: unpackedRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'e2e-browser-checks',
        RELEASE_EVIDENCE_DIR: evidenceDir,
        RELEASE_E2E_STRICT_MODE: '0',
        RELEASE_E2E_ALLOW_FALLBACK: '1',
        RELEASE_APPROVAL_MODE: '0',
        CI: '0'
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, `validate:master failed in unpacked artifact flow: ${result.stderr || result.stdout}`)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(summary.status, 'passed')
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')
    assert.equal(summary.steps[0]?.status, 'passed')
    assert.match(result.stdout, /NON-APPROVING DIAGNOSTIC MODE/)

    const e2eSummary = JSON.parse(await readFile(resolve(evidenceDir, 'e2e-summary.json'), 'utf8'))
    assert.equal(e2eSummary.status, 'passed')
    assert.equal(String(e2eSummary.executionMode || ''), 'fallback')
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('validate:master release_approval mode rejects fallback and cannot pass via fallback settings', async () => {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'klient-validate-e2e-approval-'))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')
  const evidenceDir = resolve(artifactRoot, 'evidence')
  const evidenceFile = resolve(evidenceDir, 'validate-master-summary.json')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  try {
    const result = spawnSync(process.execPath, ['scripts/master-validate.mjs'], {
      cwd: unpackedRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        VALIDATE_MASTER_STEPS: 'e2e-browser-checks',
        RELEASE_EVIDENCE_DIR: evidenceDir,
        RELEASE_E2E_STRICT_MODE: '0',
        RELEASE_E2E_ALLOW_FALLBACK: '1',
        RELEASE_APPROVAL_MODE: '1',
        CI: '0'
      },
      encoding: 'utf8'
    })

    assert.notEqual(result.status, 0, 'validate:master unexpectedly passed in release approval mode with fallback settings')
    assert.doesNotMatch(result.stdout, /NON-APPROVING DIAGNOSTIC MODE/)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')
    assert.equal(summary.steps[0]?.status, 'failed')
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})
