import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { detectStrictModeIntent, provisionChromiumForStrictMode, resolvePlaywrightEvidenceLinkage, resolvePlaywrightLinkageEnv } from './playwright-provisioning.mjs'

test('detectStrictModeIntent respects explicit strict override', () => {
  const result = detectStrictModeIntent({ RELEASE_E2E_STRICT_MODE: '0', CI: '1' })
  assert.equal(result.strictMode, false)
  assert.equal(result.source, 'RELEASE_E2E_STRICT_MODE')
})

test('resolvePlaywrightLinkageEnv wires report and provisioning defaults from evidence dir', () => {
  const cwd = '/repo'
  const env = resolvePlaywrightLinkageEnv(
    {
      RELEASE_EVIDENCE_DIR: 'artifacts/release-evidence'
    },
    { cwd }
  )

  assert.equal(env.PLAYWRIGHT_JSON_REPORT, resolve(cwd, 'artifacts/release-evidence/playwright-report.json'))
  assert.equal(env.RELEASE_E2E_PLAYWRIGHT_REPORT, resolve(cwd, 'artifacts/release-evidence/playwright-report.json'))
  assert.equal(env.RELEASE_E2E_PROVISIONING_ARTIFACT, resolve(cwd, 'artifacts/release-evidence/playwright-provisioning.txt'))
  assert.equal(env.RELEASE_E2E_BROWSER_NAME, 'chromium')
})

test('provisionChromiumForStrictMode no-ops outside strict mode', async () => {
  const result = await provisionChromiumForStrictMode({
    strictMode: false,
    env: {
      RELEASE_EVIDENCE_DIR: 'artifacts/release-evidence'
    },
    cwd: '/repo'
  })

  assert.equal(result.attempted, false)
  assert.equal(result.strictMode, false)
  assert.equal(result.env.RELEASE_E2E_PROVISIONING_VERSION, '')
})

test('resolvePlaywrightEvidenceLinkage emits evidence-dir-relative canonical paths', () => {
  const cwd = '/repo'
  const evidenceDir = resolve(cwd, 'artifacts/release-evidence/2026-04-14.1')
  const linkage = resolvePlaywrightEvidenceLinkage(
    {
      RELEASE_E2E_PLAYWRIGHT_REPORT: resolve(evidenceDir, 'playwright-report.json'),
      RELEASE_E2E_PROVISIONING_ARTIFACT: resolve(evidenceDir, 'playwright-provisioning.txt'),
      RELEASE_E2E_PROVISIONING_VERSION: '1.55.0'
    },
    { cwd, evidenceDir }
  )

  assert.equal(linkage.reportPath, 'playwright-report.json')
  assert.equal(linkage.provisioningArtifactPath, 'playwright-provisioning.txt')
  assert.equal(linkage.provisioningVersion, '1.55.0')
})
