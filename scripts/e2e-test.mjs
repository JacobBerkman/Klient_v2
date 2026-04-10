import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createEvidenceRecorder } from './release-evidence.mjs'
import { createTestContext } from './test-harness.mjs'

const uiContractSuites = ['apps/web/public/ui-contract.test.mjs']
const browserSuitePattern = 'tests/e2e'

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

function runCommand(command, args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env
    })
    child.on('exit', (code, signal) => resolveRun({ code: code ?? 1, signal }))
    child.on('error', (error) => resolveRun({ code: 1, signal: null, error }))
  })
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
    error,
    details: {
      suites: {
        uiContract: uiContractSuites,
        browser: [browserSuitePattern]
      },
      artifacts: {
        playwrightJsonReport: validation.artifact
      },
      uiContract: uiContractStatus,
      browser: { status: 'failed', exitCode: 0 }
    }
  })

  process.exitCode = 1
  return validation
}

export async function main() {
  const context = await createTestContext('e2e-browser-suite')

  try {
    await rm(playwrightReportPath, { force: true })

    const baseEnv = {
      ...process.env,
      PORT: String(context.port),
      KLIENT_BASE_URL: `http://127.0.0.1:${context.port}`,
      PLAYWRIGHT_JSON_REPORT: playwrightReportPath,
      RELEASE_E2E_PLAYWRIGHT_REPORT: playwrightReportPath,
      TEST_RESET_BEHAVIOR: process.env.TEST_RESET_BEHAVIOR || 'isolated'
    }

    const uiContractResult = await runCommand(process.execPath, ['--test', ...uiContractSuites], baseEnv)
    if (uiContractResult.signal || uiContractResult.code !== 0) {
      const error = new Error(
        uiContractResult.signal
          ? `UI contract checks terminated by signal ${uiContractResult.signal}`
          : `UI contract checks failed with exit code ${uiContractResult.code}`
      )
      evidence.finalize({
        status: 'failed',
        error,
        details: {
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          uiContract: { status: 'failed', exitCode: uiContractResult.code }
        }
      })
      process.exit(1)
      return
    }

    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const playwrightResult = await runCommand(command, ['playwright', 'test', browserSuitePattern], baseEnv)

    if (playwrightResult.signal || playwrightResult.code !== 0) {
      const error = new Error(
        playwrightResult.signal
          ? `Playwright browser suite terminated by signal ${playwrightResult.signal}`
          : `Playwright browser suite failed with exit code ${playwrightResult.code}`
      )
      evidence.finalize({
        status: 'failed',
        error,
        details: {
          suites: {
            uiContract: uiContractSuites,
            browser: [browserSuitePattern]
          },
          artifacts: {
            playwrightJsonReport: {
              path: playwrightReportPath,
              valid: false,
              reason: 'Playwright process failed before report validation'
            }
          },
          uiContract: { status: 'passed', exitCode: 0 },
          browser: { status: 'failed', exitCode: playwrightResult.code }
        }
      })
      process.exit(1)
      return
    }

    const reportValidation = await gatePlaywrightReportOrFail({ reportPath: playwrightReportPath, uiContractStatus: { status: 'passed', exitCode: 0 } })
    if (!reportValidation.ok) {
      process.exit(1)
      return
    }

    evidence.finalize({
      status: 'passed',
      details: {
        suites: {
          uiContract: uiContractSuites,
          browser: reportValidation.suiteNames
        },
        artifacts: {
          playwrightJsonReport: reportValidation.artifact
        },
        uiContract: { status: 'passed', exitCode: 0 },
        browser: { status: 'passed', exitCode: 0 }
      }
    })
  } catch (error) {
    evidence.finalize({ status: 'failed', error })
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
  await main()
}
