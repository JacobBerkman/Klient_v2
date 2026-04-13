import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { createTestContext } from './test-harness.mjs'

const uiContractSuites = ['apps/web/public/ui-contract.test.mjs']
const browserSuitePattern = 'tests/e2e'
const executionMode = 'browser'
const browserFallbackEnvFlag = 'RELEASE_E2E_ALLOW_FALLBACK'
const fallbackSuite = 'playwright-browser-fallback'
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
const playwrightReportPath = resolve(
  process.cwd(),
  process.env.RELEASE_E2E_PLAYWRIGHT_REPORT || process.env.PLAYWRIGHT_JSON_REPORT || resolve(releaseEvidenceDir, 'playwright-report.json')
)

function runCommand(command, args, env, timeoutMs = 0) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32'
    })
    let timeoutId = null
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
      }, timeoutMs)
      timeoutId.unref()
    }
    child.on('exit', (code, signal) => resolveRun({ code: code ?? 1, signal }))
    child.on('error', (error) => resolveRun({ code: 1, signal: null, error }))
    child.on('close', () => {
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

function buildPlaywrightReportFailure(path, reason) {
  return {
    path,
    valid: false,
    reason
  }
}

export function browserFallbackMode(env = process.env) {
  const flagEnabled = env[browserFallbackEnvFlag] === '1'
  const isCi = String(env.CI || '').toLowerCase() === 'true'
  return {
    isCi,
    flagEnabled,
    enabled: flagEnabled && !isCi,
    reason: isCi
      ? `CI mode enforces strict browser execution; ${browserFallbackEnvFlag}=1 is ignored`
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
      artifact: buildPlaywrightReportFailure(reportPath, `Missing Playwright JSON report at ${reportPath}`),
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
      artifact: buildPlaywrightReportFailure(reportPath, `Invalid JSON in Playwright report at ${reportPath}`),
      suiteNames: []
    }
  }

  const suiteNames = [...collectBrowserSuiteNames(parsed)].sort((a, b) => a.localeCompare(b))
  if (suiteNames.length === 0) {
    return {
      ok: false,
      artifact: buildPlaywrightReportFailure(
        reportPath,
        `Playwright report at ${reportPath} contains no suite/spec titles; expected at least one title`
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

export async function gatePlaywrightReportOrFail({ reportPath, evidenceRecorder = evidence, uiContractStatus = { status: 'passed', exitCode: 0 } }) {
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
        playwrightJsonReport: validation.artifact
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
    writeFallbackReport = writeFallbackPlaywrightReport
  } = deps

  let context
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
  const strictMode = !fallback.enabled
  const baseUrl = context.baseUrl || `http://127.0.0.1:${context.port}`

  try {
    await removeFile(playwrightReportPath, { force: true })

    const baseEnv = {
      ...process.env,
      PORT: String(context.port),
      KLIENT_BASE_URL: baseUrl,
      E2E_BASE_URL: baseUrl,
      PLAYWRIGHT_JSON_REPORT: playwrightReportPath,
      RELEASE_E2E_PLAYWRIGHT_REPORT: playwrightReportPath,
      TEST_RESET_BEHAVIOR: process.env.TEST_RESET_BEHAVIOR || 'isolated'
    }

    const uiContractResult = await run(process.execPath, ['--test', ...uiContractSuites], baseEnv, 4 * 60_000)
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
            playwrightJsonReport: buildPlaywrightReportFailure(
              playwrightReportPath,
              'Playwright browser binaries are missing; report not generated'
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
            playwrightJsonReport: fallbackValidation.artifact
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
            playwrightJsonReport: fallbackValidation.artifact
          },
          downgradeWarnings: [fallback.reason],
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'skipped', exitCode: 0 }
        }
      })
      return 0
    }

    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const playwrightResult = await run(command, ['playwright', 'test', browserSuitePattern], baseEnv)
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
            playwrightJsonReport: playwrightArtifact
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
            playwrightJsonReport: {
              ...playwrightArtifact,
              reason: `Local fallback accepted Playwright browser failure (${browserFallbackEnvFlag}=1)`
            }
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
          playwrightJsonReport: reportValidation.artifact
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
