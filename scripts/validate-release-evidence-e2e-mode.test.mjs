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
    await writeFile(resolve(evidenceDir, file), '{"status":"passed"}\n', 'utf8')
  }

  const e2eFixture = await readFile(resolve(fixturesDir, e2eFixtureName), 'utf8')
  await writeFile(resolve(evidenceDir, 'e2e-summary.json'), `${e2eFixture.trim()}\n`, 'utf8')

  await writeFile(resolve(evidenceDir, 'backup.json'), '{"ok":true}\n', 'utf8')
  await writeFile(resolve(evidenceDir, 'branch-parity.txt'), 'ok\n', 'utf8')
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

test('strict mode passes on release refs when executionMode=browser', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'browser.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { GITHUB_REF: 'refs/heads/release/2026-04-10' }
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  await rm(context.root, { recursive: true, force: true })
})

test('strict mode fails on release tags when executionMode=fallback', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'fallback-clean.json' })

  const result = runValidate({
    evidenceDir: context.evidenceDir,
    env: { GITHUB_REF: 'refs/tags/release-2026-04-10' }
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /E2E strict mode is required/)
  await rm(context.root, { recursive: true, force: true })
})

test('local validation allows fallback mode when ref is not release', async () => {
  const context = await createEvidenceDir({ e2eFixtureName: 'fallback-with-warning.json' })

  const result = runValidate({ evidenceDir: context.evidenceDir, env: { GITHUB_REF: 'refs/heads/feature/local-test' } })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  await rm(context.root, { recursive: true, force: true })
})
