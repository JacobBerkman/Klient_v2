import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const strictModeEnvFlag = 'RELEASE_E2E_STRICT_MODE'

function parseBooleanSignal(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function extractPlaywrightVersion(output = '') {
  const explicitVersion = String(output).match(/Version\s+([0-9]+\.[0-9]+\.[0-9]+)/i)
  if (explicitVersion) return explicitVersion[1]
  const packageVersion = String(output).match(/playwright@([0-9]+\.[0-9]+\.[0-9]+)/i)
  return packageVersion ? packageVersion[1] : 'unknown'
}

function extractChromiumVersion(output = '') {
  const chromeForTesting = String(output).match(/Chrome(?:\s+for\s+Testing)?\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/i)
  if (chromeForTesting) return chromeForTesting[1]
  return null
}

function extractChromiumRevision(output = '') {
  const revisionMatch = String(output).match(/playwright chromium v([0-9]+)/i)
  return revisionMatch ? revisionMatch[1] : null
}

function resolveEvidenceDir(env = process.env, cwd = process.cwd()) {
  return resolve(cwd, env.RELEASE_EVIDENCE_DIR || 'artifacts/release-evidence')
}

export function detectStrictModeIntent(env = process.env) {
  const strictOverride = parseBooleanSignal(env[strictModeEnvFlag])
  const ciSignal = parseBooleanSignal(env.CI)
  const isCi = ciSignal ?? (typeof env.CI === 'string' && env.CI.trim().length > 0)
  const strictMode = strictOverride ?? isCi
  return {
    strictMode,
    isCi,
    source: strictOverride !== null ? strictModeEnvFlag : 'CI'
  }
}

export function resolvePlaywrightLinkageEnv(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd()
  const evidenceDir = options.evidenceDir || resolveEvidenceDir(env, cwd)
  const reportPath = resolve(cwd, env.RELEASE_E2E_PLAYWRIGHT_REPORT || env.PLAYWRIGHT_JSON_REPORT || resolve(evidenceDir, 'playwright-report.json'))
  const provisioningArtifactPath = resolve(cwd, env.RELEASE_E2E_PROVISIONING_ARTIFACT || resolve(evidenceDir, 'playwright-provisioning.txt'))
  const provisioningVersion = String(env.RELEASE_E2E_PROVISIONING_VERSION || '').trim()

  return {
    PLAYWRIGHT_JSON_REPORT: reportPath,
    RELEASE_E2E_PLAYWRIGHT_REPORT: reportPath,
    RELEASE_E2E_PROVISIONING_ARTIFACT: provisioningArtifactPath,
    RELEASE_E2E_PROVISIONING_VERSION: provisioningVersion,
    RELEASE_E2E_BROWSER_NAME: String(env.RELEASE_E2E_BROWSER_NAME || '').trim() || 'chromium'
  }
}

export function resolvePlaywrightEvidenceLinkage(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd()
  const evidenceDir = options.evidenceDir || resolveEvidenceDir(env, cwd)
  const linkageEnv = resolvePlaywrightLinkageEnv(env, { cwd, evidenceDir })
  const reportAbsolute = resolve(cwd, linkageEnv.RELEASE_E2E_PLAYWRIGHT_REPORT)
  const provisioningAbsolute = resolve(cwd, linkageEnv.RELEASE_E2E_PROVISIONING_ARTIFACT)
  return {
    reportPath: relative(evidenceDir, reportAbsolute),
    reportPathAbsolute: reportAbsolute,
    provisioningArtifactPath: relative(evidenceDir, provisioningAbsolute),
    provisioningArtifactPathAbsolute: provisioningAbsolute,
    provisioningVersion: linkageEnv.RELEASE_E2E_PROVISIONING_VERSION || null
  }
}

async function runCommandCapture(command, args, env, cwd = process.cwd()) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', (error) => resolveRun({ code: 1, signal: null, stdout, stderr, error }))
    child.on('close', (code, signal) => resolveRun({ code: code ?? 1, signal, stdout, stderr }))
  })
}

export async function provisionChromiumForStrictMode(options = {}) {
  const env = { ...process.env, ...(options.env || {}) }
  const cwd = options.cwd || process.cwd()
  const strictMode = options.strictMode ?? detectStrictModeIntent(env).strictMode
  const linkage = resolvePlaywrightLinkageEnv(env, {
    cwd,
    evidenceDir: options.evidenceDir
  })
  const runProvisionCommand = options.runCommandCapture || runCommandCapture

  if (!strictMode) {
    return {
      strictMode: false,
      attempted: false,
      command: null,
      env: linkage
    }
  }

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const chromiumArgs = ['playwright', 'install', '--with-deps', 'chromium']
  const chromiumResult = await runProvisionCommand(command, chromiumArgs, { ...env, ...linkage }, cwd)
  let combinedOutput = `${chromiumResult.stdout || ''}${chromiumResult.stderr || ''}`
  let selectedCommand = `${command} ${chromiumArgs.join(' ')}`
  let finalResult = chromiumResult

  const chromiumUnavailable =
    chromiumResult.signal ||
    chromiumResult.code !== 0 ||
    /Domain forbidden/i.test(combinedOutput) ||
    /Failed to download Chrome for Testing/i.test(combinedOutput)

  if (chromiumUnavailable) {
    const chromeVersion = extractChromiumVersion(combinedOutput)
    const chromiumRevision = extractChromiumRevision(combinedOutput)
    if (chromeVersion && chromiumRevision) {
      const cacheRoot = resolve(env.PLAYWRIGHT_BROWSERS_PATH || resolve(env.HOME || '~', '.cache/ms-playwright'))
      const chromiumDir = resolve(cacheRoot, `chromium-${chromiumRevision}`)
      const headlessShellDir = resolve(cacheRoot, `chromium_headless_shell-${chromiumRevision}`)
      const chromeZip = resolve(cacheRoot, `chrome-linux64-${chromeVersion}.zip`)
      const shellZip = resolve(cacheRoot, `chrome-headless-shell-linux64-${chromeVersion}.zip`)
      await mkdir(cacheRoot, { recursive: true })

      const chromeUrl = `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/linux64/chrome-linux64.zip`
      const shellUrl = `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/linux64/chrome-headless-shell-linux64.zip`
      const installFallbackResult = await runProvisionCommand(
        'bash',
        [
          '-lc',
          [
            `curl -fsSL ${JSON.stringify(chromeUrl)} -o ${JSON.stringify(chromeZip)}`,
            `curl -fsSL ${JSON.stringify(shellUrl)} -o ${JSON.stringify(shellZip)}`,
            `rm -rf ${JSON.stringify(chromiumDir)} ${JSON.stringify(headlessShellDir)}`,
            `mkdir -p ${JSON.stringify(chromiumDir)} ${JSON.stringify(headlessShellDir)}`,
            `unzip -qo ${JSON.stringify(chromeZip)} -d ${JSON.stringify(chromiumDir)}`,
            `unzip -qo ${JSON.stringify(shellZip)} -d ${JSON.stringify(headlessShellDir)}`
          ].join(' && ')
        ],
        env,
        cwd
      )
      combinedOutput += `\n\n--- chromium provisioning fallback: chrome-for-testing direct install ---\n${installFallbackResult.stdout || ''}${installFallbackResult.stderr || ''}`
      if (!installFallbackResult.signal && installFallbackResult.code === 0) {
        selectedCommand = `curl ${chromeUrl} && curl ${shellUrl} && unzip`
        finalResult = { code: 0, signal: null, stdout: '', stderr: '' }
      }
    }
  }

  await mkdir(dirname(linkage.RELEASE_E2E_PROVISIONING_ARTIFACT), { recursive: true })
  await writeFile(linkage.RELEASE_E2E_PROVISIONING_ARTIFACT, combinedOutput, 'utf8')

  const version = extractPlaywrightVersion(combinedOutput)
  const resolvedLinkage = {
    ...linkage,
    RELEASE_E2E_PROVISIONING_VERSION: version
  }

  if (finalResult.signal || finalResult.code !== 0) {
    const failureMessage = finalResult.signal
      ? `Playwright provisioning terminated by signal ${finalResult.signal}`
      : `Playwright provisioning failed with exit code ${finalResult.code}`
    throw new Error(`${failureMessage}; artifact: ${resolvedLinkage.RELEASE_E2E_PROVISIONING_ARTIFACT}`)
  }

  return {
    strictMode: true,
    attempted: true,
    command: selectedCommand,
    env: resolvedLinkage
  }
}
