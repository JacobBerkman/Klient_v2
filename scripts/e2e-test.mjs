import { createEvidenceRecorder } from './release-evidence.mjs'
import { createTestContext } from './test-harness.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'

function summarizePlaywrightReport(report) {
  if (!report || typeof report !== 'object') {
    return {
      stats: null,
      projectCount: 0,
      suiteCount: 0,
      specCount: 0,
      errorCount: 0
    }
  }

  const suites = Array.isArray(report.suites) ? report.suites : []
  let suiteCount = 0
  let specCount = 0

  const stack = [...suites]
  while (stack.length > 0) {
    const suite = stack.pop()
    if (!suite || typeof suite !== 'object') continue

    suiteCount += 1

    if (Array.isArray(suite.specs)) {
      specCount += suite.specs.length
    }

    if (Array.isArray(suite.suites)) {
      stack.push(...suite.suites)
    }
  }

  return {
    stats: report.stats || null,
    projectCount: Array.isArray(report.config?.projects) ? report.config.projects.length : 0,
    suiteCount,
    specCount,
    errorCount: Array.isArray(report.errors) ? report.errors.length : 0
  }
}

const evidence = createEvidenceRecorder({
  gate: 'e2e',
  defaultFile: 'e2e-summary.json',
  envVarName: 'RELEASE_EVIDENCE_E2E_FILE',
  command: 'npm run test:e2e:browser',
  metadata: {
    runner: 'playwright',
    testScript: 'tests/e2e/*.spec.mjs'
  }
})

const playwrightReportFile = resolve(
  process.cwd(),
  process.env.RELEASE_E2E_PLAYWRIGHT_REPORT ||
    process.env.PLAYWRIGHT_JSON_REPORT ||
    resolve(dirname(evidence.evidenceFile), 'playwright-report.json')
)
mkdirSync(dirname(playwrightReportFile), { recursive: true })

const context = await createTestContext('e2e-browser')
const baseUrl = `http://127.0.0.1:${context.port}`

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', '--config=playwright.config.mjs'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      KLIENT_BASE_URL: baseUrl,
      E2E_BASE_URL: baseUrl,
      PLAYWRIGHT_JSON_REPORT: playwrightReportFile,
      RELEASE_E2E_PLAYWRIGHT_REPORT: playwrightReportFile
    }
  }
)

child.on('exit', async (code, signal) => {
  try {
    const reportExists = existsSync(playwrightReportFile)
    const report = reportExists ? JSON.parse(readFileSync(playwrightReportFile, 'utf8')) : null

    const details = {
      browserRun: {
        baseUrl,
        reportFile: playwrightReportFile,
        reportExists,
        ...summarizePlaywrightReport(report)
      }
    }

    if (signal) {
      evidence.finalize({ status: 'failed', details, error: new Error(`terminated by signal ${signal}`) })
      process.stderr.write(`E2E browser checks terminated by signal ${signal}.\n`)
      process.exitCode = 1
      return
    }

    if ((code ?? 1) !== 0) {
      evidence.finalize({
        status: 'failed',
        error: new Error(`exit code ${code ?? 1}`),
        details
      })
      process.stderr.write(`E2E browser checks failed with exit code ${code ?? 1}.\n`)
      process.exitCode = code ?? 1
      return
    }

    evidence.finalize({ status: 'passed', details })
    process.exitCode = 0
  } finally {
    await context.shutdown()
    process.exit(process.exitCode ?? 1)
  }
})
