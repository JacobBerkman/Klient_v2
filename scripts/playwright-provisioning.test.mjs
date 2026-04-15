import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
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

test('provisionChromiumForStrictMode falls back to direct Chrome-for-Testing install with playwright cache layout', async () => {
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'pw-provision-fallback-'))
  const evidenceDir = resolve(tempRoot, 'evidence')
  const evidenceArtifact = resolve(evidenceDir, 'playwright-provisioning.txt')
  const cacheRoot = resolve(tempRoot, 'ms-playwright-cache')
  const commands = []

  const runCommandCapture = async (command, args) => {
    commands.push({ command, args })
    if (command.startsWith('npx')) {
      return {
        code: 1,
        signal: null,
        stdout: '',
        stderr:
          'Failed to download Chrome for Testing\nplaywright chromium v1187\nChrome for Testing 140.0.7339.16\nVersion 1.55.0\n'
      }
    }

    return {
      code: 0,
      signal: null,
      stdout: 'fallback installed',
      stderr: ''
    }
  }

  try {
    const result = await provisionChromiumForStrictMode({
      strictMode: true,
      cwd: tempRoot,
      evidenceDir,
      env: {
        PLAYWRIGHT_BROWSERS_PATH: cacheRoot,
        RELEASE_E2E_PROVISIONING_ARTIFACT: evidenceArtifact
      },
      runCommandCapture
    })

    assert.equal(result.attempted, true)
    assert.equal(result.strictMode, true)
    assert.equal(result.command.includes('curl'), true)
    assert.equal(result.env.RELEASE_E2E_PROVISIONING_VERSION, '1.55.0')
    assert.equal(commands.length, 2)
    assert.equal(commands[1].command, 'bash')
    const fallbackShell = commands[1].args[1]
    assert.match(fallbackShell, /chrome-linux64-140\.0\.7339\.16\.zip/)
    assert.match(fallbackShell, /chrome-headless-shell-linux64-140\.0\.7339\.16\.zip/)
    assert.match(fallbackShell, /chromium-1187/)
    assert.match(fallbackShell, /chromium_headless_shell-1187/)
    assert.match(fallbackShell, /unzip -qo/)

    const artifactBody = await readFile(evidenceArtifact, 'utf8')
    assert.match(artifactBody, /chromium provisioning fallback: chrome-for-testing direct install/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
