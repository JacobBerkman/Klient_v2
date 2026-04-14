import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const validateScript = resolve(repoRoot, 'scripts/validate-release-evidence.mjs')
const fixturesDir = resolve(repoRoot, 'scripts/fixtures/e2e-modes')

async function createEvidenceDir({ e2eFixtureName }) {
  const root = await mkdtemp(resolve(tmpdir(), 'release-evidence-'))
  const evidenceDir = resolve(root, 'artifacts/release-evidence/test-release')
  await mkdir(evidenceDir, { recursive: true })

  const summaryFiles = [
    'validate-master-summary.json',
    'api-contract-summary.json',
    'integration-summary.json',
    'migration-summary.json',
    'smoke-summary.json',
    'security-summary.json'
  ]
  for (const file of summaryFiles) {
    const gate = file.replace('-summary.json', '').replace('api-contract', 'contract')
    await writeFile(resolve(evidenceDir, file), JSON.stringify({ status: 'passed', error: null, gate }) + '\n', 'utf8')
  }

  const e2eFixture = JSON.parse(await readFile(resolve(fixturesDir, e2eFixtureName), 'utf8'))
  const linkage = e2eFixture?.details?.artifacts?.playwrightEvidenceLinkage
  if (linkage && typeof linkage === 'object') {
    linkage.reportPathAbsolute = resolve(evidenceDir, linkage.reportPath || 'playwright-report.json')
    if (typeof linkage.provisioningArtifactPath === 'string' && linkage.provisioningArtifactPath.trim().length > 0) {
      linkage.provisioningArtifactPathAbsolute = resolve(evidenceDir, linkage.provisioningArtifactPath)
    } else {
      linkage.provisioningArtifactPathAbsolute = null
    }
  }
  await writeFile(resolve(evidenceDir, 'e2e-summary.json'), `${JSON.stringify(e2eFixture)}\n`, 'utf8')
  await writeFile(resolve(evidenceDir, 'playwright-report.json'), '{"suites":[{"title":"release blocking smoke"}]}\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'playwright-provisioning.txt'), 'Version 1.55.0\n', 'utf8')

  await writeFile(resolve(evidenceDir, 'backup.json'), '{"ok":true}\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'branch-parity.txt'), 'ok\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'preflight-env-summary.json'), '{"overall":{"ready":true}}\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'startup-failfast.json'), '{"ok":true}\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'startup-failfast.txt'), 'ok\n', 'utf8')

  await writeFile(
    resolve(evidenceDir, 'manifest.json'),
    `${JSON.stringify(
      {
        phaseStatuses: {
          preflight: { status: 'passed' },
          postdeploy: { status: 'skipped' },
          restore: { status: 'skipped' },
          'restore-drill': { status: 'skipped' }
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  return { root, evidenceDir }
}

function runValidate({ evidenceDir, env = {} }) {
  return spawnSync(process.execPath, [validateScript, '--release-id', 'test-release', '--phase', 'preflight', '--evidence-dir', evidenceDir], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

test('release ref validation mode enforces strict browser execution', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'fallback-clean.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { GITHUB_REF: 'refs/heads/release/2026-04-10' }
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /validationMode=local/)
  assert.match(result.stderr, /Prohibited approval fallback/)
  await rm(context.root, { recursive: true, force: true })
})

test('local mode allows fallback and emits mode schema in success report', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'fallback-with-warning.json' })

  const result = runValidate({ evidenceDir: context.evidenceDir, env: { GITHUB_REF: 'refs/heads/feature/local-test', CI: '0' } })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /validationMode=local/)
  assert.match(result.stdout, /strictE2E=false/)
  assert.match(result.stdout, /Accepted diagnostic fallback \(non-approving\)/)
  assert.match(result.stdout, /e2eApprovalPolicy=diagnostic_local/)
  await rm(context.root, { recursive: true, force: true })
})

test('ci mode is strict even without release refs', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'fallback-with-warning.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { GITHUB_REF: 'refs/heads/feature/non-release', CI: 'true' }
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /validationMode=ci/)
  assert.match(result.stderr, /Prohibited approval fallback/)
  await rm(context.root, { recursive: true, force: true })
})

test('ci mode succeeds with browser execution and reports strict schema', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'browser.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { CI: 'true', GITHUB_REF: 'refs/heads/feature/non-release' }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /validationMode=ci/)
  assert.match(result.stdout, /strictE2E=true/)
  assert.match(result.stdout, /e2eApprovalPolicy=release_approval/)
  await rm(context.root, { recursive: true, force: true })
})

test('unpacked-artifact mode is strict and encoded in output schema', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'browser.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { RELEASE_EVIDENCE_UNPACKED_ARTIFACT: '1', CI: '0', GITHUB_REF: 'refs/heads/feature/non-release' }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /validationMode=unpacked-artifact/)
  assert.match(result.stdout, /strictE2E=true/)
  assert.match(result.stdout, /e2eApprovalPolicy=release_approval/)
  await rm(context.root, { recursive: true, force: true })
})

test('fails when e2e summary is missing playwright report metadata fields', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'browser.json' })
  await writeFile(resolve(context.evidenceDir, 'e2e-summary.json'), '{"status":"passed","error":null,"gate":"e2e","executionMode":"browser","details":{"artifacts":{}}}\n', 'utf8')

  const result = runValidate({ evidenceDir: context.evidenceDir, env: { GITHUB_REF: 'refs/heads/release/2026-04-10' } })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /playwrightJsonReport metadata/)
  await rm(context.root, { recursive: true, force: true })
})

test('fails when key gate summary is not passed', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'browser.json' })
  await writeFile(resolve(context.evidenceDir, 'security-summary.json'), '{"status":"failed","error":{"message":"boom"}}\n', 'utf8')

  const result = runValidate({ evidenceDir: context.evidenceDir })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /security-summary\.json must have status=passed/)
  await rm(context.root, { recursive: true, force: true })
})
