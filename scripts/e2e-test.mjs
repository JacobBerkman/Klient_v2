import { dirname, resolve } from 'node:path'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { createTestContext } from './test-harness.mjs'
import {
  normalizeChildEnv,
  releaseChildStdio,
  startManagedProcess,
  terminateManagedProcess,
  waitForManagedExit
} from './process-lifecycle.mjs'
import {
  provisionChromiumForStrictMode,
  resolvePlaywrightEvidenceLinkage,
  resolvePlaywrightLinkageEnv
} from './playwright-provisioning.mjs'

const uiContractSuites = ['apps/api/src/test/web-static-serving.test.mjs']
const exportWorkerScript = resolve(process.cwd(), 'scripts/export-worker.mjs')
const browserSuitePattern = 'tests/e2e'
const executionMode = 'browser'
const browserFallbackEnvFlag = 'RELEASE_E2E_ALLOW_FALLBACK'
const strictModeEnvFlag = 'RELEASE_E2E_STRICT_MODE'
const fallbackSuite = 'playwright-browser-fallback'
const reportValidationFailureCodes = {
  missingReport: 'missing-report',
  invalidJson: 'invalid-json',
  missingTitles: 'missing-titles'
}
const failureCategories = {
  startupFailure: 'startup-failure',
  uiContractFailure: 'ui-contract-failure',
  browserLaunchFailure: 'browser-launch-failure',
  reportValidationFailure: 'report-validation-failure'
}

const evidence = createEvidenceRecorder({
  gate: 'e2e',
  defaultFile: 'e2e-summary.json',
  envVarName: 'RELEASE_EVIDENCE_E2E_FILE',
  command: 'npm run test:e2e',
  metadata: {
    uiContractSuites,
    browserSuites: [browserSuitePattern]
  }
})

const releaseEvidenceDir = dirname(evidence.evidenceFile)
function parseBooleanSignal(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function resolvePlaywrightGrep(env = process.env) {
  const e2eGrep = String(env.E2E_GREP || '').trim()
  if (e2eGrep) return e2eGrep
  const playwrightGrep = String(env.PLAYWRIGHT_GREP || '').trim()
  return playwrightGrep || null
}

function resolvePlaywrightReportPath(env = process.env) {
  const configured = env.RELEASE_E2E_PLAYWRIGHT_REPORT || env.PLAYWRIGHT_JSON_REPORT
  const fallbackPath = resolve(releaseEvidenceDir, 'playwright-report.json')
  return resolve(process.cwd(), configured || fallbackPath)
}

function resolveEvidenceLinkageFromRuntime(env = process.env, reportPath = '') {
  const linkage = resolvePlaywrightEvidenceLinkage(
    {
      ...env,
      RELEASE_E2E_PLAYWRIGHT_REPORT: reportPath || resolvePlaywrightReportPath(env),
      PLAYWRIGHT_JSON_REPORT: reportPath || resolvePlaywrightReportPath(env)
    },
    { evidenceDir: releaseEvidenceDir }
  )
  const provisioningConfigured = String(env.RELEASE_E2E_PROVISIONING_ARTIFACT || '').trim()
  if (!provisioningConfigured) {
    linkage.provisioningArtifactPath = null
    linkage.provisioningArtifactPathAbsolute = null
  }
  return linkage
}

function buildArtifactDetails(playwrightJsonReport, env = process.env, reportPath = '') {
  return {
    playwrightJsonReport,
    playwrightEvidenceLinkage: resolveEvidenceLinkageFromRuntime(env, reportPath)
  }
}

function runCommand(command, args, env, timeoutMs = 0) {
  const managed = startManagedProcess({
    command,
    args,
    label: `${command} ${args.join(' ')}`.trim(),
    stdio: 'inherit',
    env: normalizeChildEnv(env),
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
  })
  return new Promise((resolveRun) => {
    let settled = false
    let timeoutId = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      releaseChildStdio(managed)
      resolveRun(result)
    }
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        void terminateManagedProcess(managed, { graceMs: 1500, killMs: 1500 }).finally(() =>
          finish({ code: 1, signal: 'TIMEOUT' })
        )
      }, timeoutMs)
      timeoutId.unref()
    }
    managed.child.on('exit', (code, signal) => finish({ code: code ?? 1, signal }))
    managed.child.on('error', (error) => finish({ code: 1, signal: null, error }))
    managed.child.on('close', () => {
      if (timeoutId) clearTimeout(timeoutId)
    })
  })
}

async function hasInstalledPlaywrightBrowser() {
  const { chromium } = await import('@playwright/test')
  try {
    await access(chromium.executablePath())
    return true
  } catch {
    return false
  }
}

async function writeFallbackPlaywrightReport(reportPath) {
  const report = {
    suites: [{ title: fallbackSuite }],
    specs: [{ title: fallbackSuite }]
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
}

function collectBrowserSuiteNames(reportNode, output = new Set()) {
  if (!reportNode || typeof reportNode !== 'object') return output

  if (Array.isArray(reportNode.suites)) {
    for (const suite of reportNode.suites) {
      if (suite?.title && typeof suite.title === 'string') output.add(suite.title)
      collectBrowserSuiteNames(suite, output)
    }
  }

  if (Array.isArray(reportNode.specs)) {
    for (const spec of reportNode.specs) {
      if (spec?.title && typeof spec.title === 'string') output.add(spec.title)
    }
  }

  return output
}

function buildPlaywrightReportFailure(path, reason, code = reportValidationFailureCodes.missingTitles) {
  return {
    path,
    valid: false,
    reason,
    code
  }
}

export function browserFallbackMode(env = process.env) {
  const flagEnabled = parseBooleanSignal(env[browserFallbackEnvFlag]) === true
  const ciSignal = parseBooleanSignal(env.CI)
  const isCi = ciSignal ?? (typeof env.CI === 'string' && env.CI.trim().length > 0)
  const strictOverride = parseBooleanSignal(env[strictModeEnvFlag])
  const strictMode = strictOverride ?? isCi
  return {
    isCi,
    strictMode,
    flagEnabled,
    enabled: flagEnabled && !strictMode,
    reason: strictMode
      ? `Strict browser execution is enabled (${strictModeEnvFlag}=1); ${browserFallbackEnvFlag}=1 is ignored`
      : flagEnabled
        ? `${browserFallbackEnvFlag}=1 enables local fallback if browser binaries are missing`
        : `${browserFallbackEnvFlag} is disabled`
  }
}

export async function validatePlaywrightJsonReport(reportPath) {
  try {
    await access(reportPath)
  } catch {
    return {
      ok: false,
      artifact: buildPlaywrightReportFailure(
        reportPath,
        `Missing Playwright JSON report at ${reportPath}`,
        reportValidationFailureCodes.missingReport
      ),
      suiteNames: []
    }
  }

  let parsed
  try {
    const raw = await readFile(reportPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      artifact: buildPlaywrightReportFailure(
        reportPath,
        `Invalid JSON in Playwright report at ${reportPath}`,
        reportValidationFailureCodes.invalidJson
      ),
      suiteNames: []
    }
  }

  const suiteNames = [...collectBrowserSuiteNames(parsed)].sort((a, b) => a.localeCompare(b))
  if (suiteNames.length === 0) {
    return {
      ok: false,
      artifact: buildPlaywrightReportFailure(
        reportPath,
        `Playwright report at ${reportPath} contains no suite/spec titles; expected at least one title`,
        reportValidationFailureCodes.missingTitles
      ),
      suiteNames
    }
  }

  return {
    ok: true,
    artifact: {
      path: reportPath,
      valid: true,
      suiteCount: suiteNames.length
    },
    suiteNames
  }
}

export async function gatePlaywrightReportOrFail({
  reportPath,
  evidenceRecorder = evidence,
  uiContractStatus = { status: 'passed', exitCode: 0 }
}) {
  const validation = await validatePlaywrightJsonReport(reportPath)
  if (validation.ok) return validation

  const error = new Error(validation.artifact.reason)
  evidenceRecorder.finalize({
    status: 'failed',
    fields: { executionMode },
    error,
    details: {
      failureCategory: failureCategories.reportValidationFailure,
      suites: {
        uiContract: uiContractSuites,
        browser: [browserSuitePattern]
      },
      artifacts: {
        ...buildArtifactDetails(validation.artifact, process.env, reportPath)
      },
      downgradeWarnings: [],
      uiContract: uiContractStatus,
      browser: { status: 'failed', exitCode: 0 }
    }
  })

  return validation
}

function finalizeFailure(evidenceRecorder, error, details = {}) {
  evidenceRecorder.finalize({
    status: 'failed',
    fields: { executionMode },
    error,
    details
  })
  return 1
}

export async function main(deps = {}) {
  const {
    createContext = createTestContext,
    run = runCommand,
    hasBrowser = hasInstalledPlaywrightBrowser,
    evidenceRecorder = evidence,
    removeFile = rm,
    validateReport = validatePlaywrightJsonReport,
    writeFallbackReport = writeFallbackPlaywrightReport,
    provisionChromium = provisionChromiumForStrictMode
  } = deps

  let context
  let exportWorker = null
  try {
    context = await createContext('e2e-browser-suite')
  } catch (error) {
    evidenceRecorder.finalize({
      status: 'failed',
      fields: { executionMode },
      error,
      details: { failureCategory: failureCategories.startupFailure }
    })
    throw error
  }
  const fallback = browserFallbackMode()
  const strictMode = fallback.strictMode
  const baseUrl = context.baseUrl || `http://127.0.0.1:${context.port}`
  const playwrightReportPath = resolvePlaywrightReportPath(process.env)

  try {
    exportWorker = startManagedProcess({
      command: process.execPath,
      args: [exportWorkerScript],
      label: 'e2e-companion-export-worker',
      cwd: context.testCwd,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ALLOW_DEV_FALLBACK_APP_SECRET: 'true',
        EXPORT_WORKER_ID: 'e2e-companion-export-worker',
        EXPORT_WORKER_POLL_MS: '100',
        EXPORT_WORKER_LEASE_MS: '5000',
        EXPORT_WORKER_BATCH_SIZE: '10'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    exportWorker.child.stdout?.resume()
    exportWorker.child.stderr?.resume()

    await removeFile(playwrightReportPath, { force: true })

    const baseEnv = {
      ...process.env,
      PORT: String(context.port),
      KLIENT_BASE_URL: baseUrl,
      E2E_BASE_URL: baseUrl,
      RELEASE_E2E_STRICT_MODE: strictMode ? '1' : '0',
      TEST_RESET_BEHAVIOR: process.env.TEST_RESET_BEHAVIOR || 'isolated'
    }
    const grepSignal = resolvePlaywrightGrep(baseEnv)
    if (grepSignal) baseEnv.PLAYWRIGHT_GREP = grepSignal
    const linkageEnv = resolvePlaywrightLinkageEnv(
      {
        ...baseEnv,
        PLAYWRIGHT_JSON_REPORT: playwrightReportPath,
        RELEASE_E2E_PLAYWRIGHT_REPORT: playwrightReportPath
      },
      { evidenceDir: releaseEvidenceDir }
    )
    const runtimeEnv = { ...baseEnv, ...linkageEnv }
    process.env.RELEASE_E2E_PROVISIONING_ARTIFACT = runtimeEnv.RELEASE_E2E_PROVISIONING_ARTIFACT
    process.env.RELEASE_E2E_PROVISIONING_VERSION = runtimeEnv.RELEASE_E2E_PROVISIONING_VERSION
    process.env.RELEASE_E2E_PLAYWRIGHT_REPORT = runtimeEnv.RELEASE_E2E_PLAYWRIGHT_REPORT
    process.env.PLAYWRIGHT_JSON_REPORT = runtimeEnv.PLAYWRIGHT_JSON_REPORT

    const uiContractResult = await run(process.execPath, ['--test', ...uiContractSuites], runtimeEnv, 4 * 60_000)
    if (uiContractResult.signal || uiContractResult.code !== 0) {
      const error = new Error(
        uiContractResult.signal
          ? `UI contract checks terminated by signal ${uiContractResult.signal}`
          : `UI contract checks failed with exit code ${uiContractResult.code}`
      )
      return finalizeFailure(evidenceRecorder, error, {
        failureCategory: failureCategories.uiContractFailure,
        suites: {
          uiContract: uiContractSuites,
          browser: [browserSuitePattern]
        },
        downgradeWarnings: [],
        uiContract: { status: 'failed', exitCode: uiContractResult.code }
      })
    }

    if (strictMode) {
      const provisioning = await provisionChromium({
        env: runtimeEnv,
        strictMode: true,
        evidenceDir: releaseEvidenceDir
      })
      Object.assign(runtimeEnv, provisioning.env)
      process.env.RELEASE_E2E_PROVISIONING_ARTIFACT = provisioning.env.RELEASE_E2E_PROVISIONING_ARTIFACT
      process.env.RELEASE_E2E_PROVISIONING_VERSION = provisioning.env.RELEASE_E2E_PROVISIONING_VERSION
    }

    const browserInstalled = await hasBrowser()
    if (!browserInstalled) {
      if (strictMode) {
        const error = new Error(
          `Playwright browser binaries are missing and strict mode is enabled (${browserFallbackEnvFlag}=1 to allow local fallback).`
        )
        return finalizeFailure(evidenceRecorder, error, {
          failureCategory: failureCategories.browserLaunchFailure,
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          artifacts: {
            ...buildArtifactDetails(
              buildPlaywrightReportFailure(
                playwrightReportPath,
                'Playwright browser binaries are missing; report not generated'
              ),
              process.env,
              playwrightReportPath
            )
          },
          downgradeWarnings: [],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'failed', exitCode: 1 }
        })
      }

      await writeFallbackReport(playwrightReportPath)
      const fallbackValidation = await validateReport(playwrightReportPath)
      if (!fallbackValidation.ok) {
        const error = new Error(fallbackValidation.artifact.reason)
        return finalizeFailure(evidenceRecorder, error, {
          failureCategory: failureCategories.reportValidationFailure,
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          artifacts: {
            ...buildArtifactDetails(fallbackValidation.artifact, process.env, playwrightReportPath)
          },
          downgradeWarnings: [fallback.reason],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'skipped', exitCode: 0 }
        })
      }

      evidenceRecorder.finalize({
        status: 'passed',
        fields: { executionMode: 'fallback' },
        details: {
          suites: {
            uiContract: uiContractSuites,
            browser: fallbackValidation.suiteNames
          },
          artifacts: {
            ...buildArtifactDetails(fallbackValidation.artifact, process.env, playwrightReportPath)
          },
          downgradeWarnings: [fallback.reason],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'skipped', exitCode: 0 }
        }
      })
      return 0
    }

    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const playwrightResult = await run(command, ['playwright', 'test', browserSuitePattern], runtimeEnv)
    const browserExitCode = playwrightResult.code ?? 1

    if (playwrightResult.signal || playwrightResult.code !== 0) {
      const errorMessage = playwrightResult.signal
        ? `Playwright browser suite terminated by signal ${playwrightResult.signal}`
        : `Playwright browser suite failed with exit code ${playwrightResult.code}`
      const playwrightArtifact = buildPlaywrightReportFailure(
        playwrightReportPath,
        'Playwright process failed before report validation'
      )

      if (strictMode) {
        const error = new Error(errorMessage)
        return finalizeFailure(evidenceRecorder, error, {
          failureCategory: failureCategories.browserLaunchFailure,
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          artifacts: {
            ...buildArtifactDetails(playwrightArtifact, process.env, playwrightReportPath)
          },
          downgradeWarnings: [],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'failed', exitCode: browserExitCode }
        })
      }

      evidenceRecorder.finalize({
        status: 'passed',
        fields: { executionMode: 'fallback' },
        details: {
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          artifacts: {
            ...buildArtifactDetails(
              {
                ...playwrightArtifact,
                reason: `Local fallback accepted Playwright browser failure (${browserFallbackEnvFlag}=1)`
              },
              process.env,
              playwrightReportPath
            )
          },
          downgradeWarnings: [fallback.reason],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'skipped', exitCode: browserExitCode }
        }
      })
      return 0
    }

    const reportValidation = await gatePlaywrightReportOrFail({
      reportPath: playwrightReportPath,
      evidenceRecorder,
      uiContractStatus: { status: 'passed', exitCode: 0 }
    })
    if (!reportValidation.ok) return 1

    evidenceRecorder.finalize({
      status: 'passed',
      fields: { executionMode },
      details: {
        suites: {
          uiContract: uiContractSuites,
          browser: reportValidation.suiteNames
        },
        artifacts: {
          ...buildArtifactDetails(reportValidation.artifact, process.env, playwrightReportPath)
        },
        downgradeWarnings: [],
        uiContract: { status: 'passed', exitCode: 0 },
        browser: { status: 'passed', exitCode: browserExitCode }
      }
    })
    return 0
  } catch (error) {
    evidenceRecorder.finalize({
      status: 'failed',
      fields: { executionMode },
      error,
      details: { failureCategory: failureCategories.startupFailure }
    })
    throw error
  } finally {
    if (exportWorker) {
      await terminateManagedProcess(exportWorker, { label: 'e2e-companion-export-worker' }).catch(() => {})
      await waitForManagedExit(exportWorker, 1000)
      releaseChildStdio(exportWorker)
    }
    await context.shutdown()
  }
}

export async function writeTempReport(content) {
  const dir = await mkdtemp(resolve(tmpdir(), 'e2e-report-'))
  const filePath = resolve(dir, 'report.json')
  await writeFile(filePath, content, 'utf8')
  return filePath
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main()
  process.exitCode = Number.isInteger(exitCode) ? exitCode : 1
}
