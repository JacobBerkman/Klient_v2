import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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
    RELEASE_E2E_PROVISIONING_VERSION: provisioningVersion
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

  if (!strictMode) {
    return {
      strictMode: false,
      attempted: false,
      command: null,
      env: linkage
    }
  }

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['playwright', 'install', '--with-deps', 'chromium']
  const result = await runCommandCapture(command, args, { ...env, ...linkage }, cwd)
  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`

  await mkdir(dirname(linkage.RELEASE_E2E_PROVISIONING_ARTIFACT), { recursive: true })
  await writeFile(linkage.RELEASE_E2E_PROVISIONING_ARTIFACT, combinedOutput, 'utf8')

  const version = extractPlaywrightVersion(combinedOutput)
  const resolvedLinkage = {
    ...linkage,
    RELEASE_E2E_PROVISIONING_VERSION: version
  }

  if (result.signal || result.code !== 0) {
    const failureMessage = result.signal
      ? `Playwright provisioning terminated by signal ${result.signal}`
      : `Playwright provisioning failed with exit code ${result.code}`
    throw new Error(`${failureMessage}; artifact: ${resolvedLinkage.RELEASE_E2E_PROVISIONING_ARTIFACT}`)
  }

  return {
    strictMode: true,
    attempted: true,
    command: `${command} ${args.join(' ')}`,
    env: resolvedLinkage
  }
}
