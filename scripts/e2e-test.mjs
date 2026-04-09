import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { access, readFile, rm } from 'node:fs/promises'
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

async function buildPlaywrightMetadata() {
  try {
    await access(playwrightReportPath)
    const raw = await readFile(playwrightReportPath, 'utf8')
    const parsed = JSON.parse(raw)
    const suiteNames = [...collectBrowserSuiteNames(parsed)].sort((a, b) => a.localeCompare(b))
    return {
      suiteNames,
      artifact: playwrightReportPath
    }
  } catch {
    return {
      suiteNames: [],
      artifact: playwrightReportPath
    }
  }
}

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
  }

  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const playwrightResult = await runCommand(command, ['playwright', 'test', browserSuitePattern], baseEnv)
  const playwrightMetadata = await buildPlaywrightMetadata()

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
          browser: playwrightMetadata.suiteNames.length ? playwrightMetadata.suiteNames : [browserSuitePattern]
        },
        artifacts: {
          playwrightJsonReport: playwrightMetadata.artifact
        },
        uiContract: { status: 'passed', exitCode: 0 },
        browser: { status: 'failed', exitCode: playwrightResult.code }
      }
    })
    process.exit(1)
  }
)

child.on('exit', async (code, signal) => {
  try {
    const reportExists = existsSync(playwrightReportFile)
    const report = reportExists ? JSON.parse(readFileSync(playwrightReportFile, 'utf8')) : null

  evidence.finalize({
    status: 'passed',
    details: {
      suites: {
        uiContract: uiContractSuites,
        browser: playwrightMetadata.suiteNames.length ? playwrightMetadata.suiteNames : [browserSuitePattern]
      },
      artifacts: {
        playwrightJsonReport: playwrightMetadata.artifact
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
