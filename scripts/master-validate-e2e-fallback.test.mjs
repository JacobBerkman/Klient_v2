import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

test('validate:master allows E2E fallback in unpacked artifact flow when strict flags are not set', async () => {
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
        RELEASE_EVIDENCE_DIR: evidenceDir
      },
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, `validate:master failed in unpacked artifact flow: ${result.stderr || result.stdout}`)

    const summary = JSON.parse(await readFile(evidenceFile, 'utf8'))
    assert.equal(summary.status, 'passed')
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')
    assert.equal(summary.steps[0]?.status, 'passed')

    const e2eSummary = JSON.parse(await readFile(resolve(evidenceDir, 'e2e-summary.json'), 'utf8'))
    assert.equal(e2eSummary.status, 'passed')
    assert.match(String(e2eSummary.executionMode || ''), /fallback|browser/)
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})
