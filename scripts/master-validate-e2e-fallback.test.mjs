import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)

async function prepareUnpackedWorkspace(prefix) {
  const artifactRoot = await mkdtemp(resolve(tmpdir(), prefix))
  const unpackedRoot = resolve(artifactRoot, 'unpacked')
  const evidenceDir = resolve(artifactRoot, 'evidence')

  await cp(repoRoot, unpackedRoot, {
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.includes('/.git')
    }
  })

  await mkdir(evidenceDir, { recursive: true })
  const provisioningArtifactPath = resolve(evidenceDir, 'playwright-provisioning.txt')
  await writeFile(provisioningArtifactPath, 'playwright provisioning evidence\n', 'utf8')

  return {
    artifactRoot,
    unpackedRoot,
    evidenceDir,
    evidenceFile: resolve(evidenceDir, 'validate-master-summary.json'),
    provisioningArtifactPath
  }
}

function runValidateMaster(unpackedRoot, envOverrides) {
  return spawnSync(process.execPath, ['scripts/master-validate.mjs'], {
    cwd: unpackedRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      VALIDATE_MASTER_STEPS: 'e2e-browser-checks',
      RELEASE_APPROVAL_MODE: '0',
      CI: '0',
      ...envOverrides
    },
    encoding: 'utf8'
  })
}

test('validate:master unpacked workspace defaults to strict E2E (no auto-fallback)', async () => {
  const workspace = await prepareUnpackedWorkspace('klient-validate-e2e-default-strict-')

  try {
    const result = runValidateMaster(workspace.unpackedRoot, {
      RELEASE_EVIDENCE_DIR: workspace.evidenceDir,
      RELEASE_E2E_PROVISIONING_ARTIFACT: workspace.provisioningArtifactPath,
      RELEASE_E2E_PROVISIONING_VERSION: 'playwright@local-test'
    })

    assert.doesNotMatch(result.stdout, /NON-APPROVING DIAGNOSTIC MODE/)

    const summary = JSON.parse(await readFile(workspace.evidenceFile, 'utf8'))
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')

    if (result.status === 0) {
      assert.equal(summary.status, 'passed')
      assert.equal(summary.steps[0]?.status, 'passed')

      const e2eSummary = JSON.parse(await readFile(resolve(workspace.evidenceDir, 'e2e-summary.json'), 'utf8'))
      assert.equal(e2eSummary.status, 'passed')
      assert.equal(String(e2eSummary.executionMode || ''), 'browser')
      assert.equal(typeof e2eSummary.details?.artifacts?.playwrightEvidenceLinkage?.provisioningArtifactPath, 'string')
      assert.ok(e2eSummary.details?.artifacts?.playwrightEvidenceLinkage?.provisioningArtifactPath)
      assert.equal(typeof e2eSummary.details?.artifacts?.playwrightEvidenceLinkage?.provisioningVersion, 'string')
      assert.ok(e2eSummary.details?.artifacts?.playwrightEvidenceLinkage?.provisioningVersion)
      return
    }

    assert.equal(summary.status, 'failed')
    assert.equal(summary.steps[0]?.status, 'failed')
    assert.notEqual(result.status, 0)
  } finally {
    await rm(workspace.artifactRoot, { recursive: true, force: true })
  }
})

test('validate:master allows diagnostic fallback only when explicitly enabled and marks non-approving mode', async () => {
  const workspace = await prepareUnpackedWorkspace('klient-validate-e2e-artifact-')

  try {
    const result = runValidateMaster(workspace.unpackedRoot, {
      RELEASE_EVIDENCE_DIR: workspace.evidenceDir,
      RELEASE_E2E_STRICT_MODE: '0',
      RELEASE_E2E_ALLOW_FALLBACK: '1'
    })

    assert.equal(result.status, 0, `validate:master failed in unpacked artifact flow: ${result.stderr || result.stdout}`)

    const summary = JSON.parse(await readFile(workspace.evidenceFile, 'utf8'))
    assert.equal(summary.status, 'passed')
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')
    assert.equal(summary.steps[0]?.status, 'passed')
    assert.match(result.stdout, /NON-APPROVING DIAGNOSTIC MODE/)

    const e2eSummary = JSON.parse(await readFile(resolve(workspace.evidenceDir, 'e2e-summary.json'), 'utf8'))
    assert.equal(e2eSummary.status, 'passed')
    assert.ok(['browser', 'fallback'].includes(String(e2eSummary.executionMode || '')))

    if (String(e2eSummary.executionMode || '') === 'fallback') {
      assert.ok(Array.isArray(e2eSummary.details?.downgradeWarnings))
      assert.ok(e2eSummary.details.downgradeWarnings.length > 0)
    }
  } finally {
    await rm(workspace.artifactRoot, { recursive: true, force: true })
  }
})

test('validate:master release_approval mode rejects fallback and cannot pass via fallback settings', async () => {
  const workspace = await prepareUnpackedWorkspace('klient-validate-e2e-approval-')

  try {
    const result = runValidateMaster(workspace.unpackedRoot, {
      RELEASE_EVIDENCE_DIR: workspace.evidenceDir,
      RELEASE_E2E_STRICT_MODE: '0',
      RELEASE_E2E_ALLOW_FALLBACK: '1',
      RELEASE_APPROVAL_MODE: '1'
    })

    assert.notEqual(result.status, 0, 'validate:master unexpectedly passed in release approval mode with fallback settings')
    assert.doesNotMatch(result.stdout, /NON-APPROVING DIAGNOSTIC MODE/)

    const summary = JSON.parse(await readFile(workspace.evidenceFile, 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.steps.length, 1)
    assert.equal(summary.steps[0]?.name, 'E2E browser checks')
    assert.equal(summary.steps[0]?.status, 'failed')
  } finally {
    await rm(workspace.artifactRoot, { recursive: true, force: true })
  }
})
