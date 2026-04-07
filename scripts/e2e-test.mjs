import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { runCommandProcess } from './runner-lifecycle.mjs'
import { createEvidenceRecorder } from './release-evidence.mjs'

const evidence = createEvidenceRecorder({
  gate: 'e2e',
  defaultFile: 'e2e-summary.json',
  envVarName: 'RELEASE_EVIDENCE_E2E_FILE',
  command: 'npm run test:e2e'
})

const releaseEvidenceDir = resolve(process.cwd(), process.env.RELEASE_EVIDENCE_DIR || 'artifacts/release-evidence')
const playwrightReport =
  process.env.RELEASE_E2E_PLAYWRIGHT_REPORT || resolve(releaseEvidenceDir, 'playwright-e2e-report.json')

function parsePlaywrightSummary(reportFile) {
  if (!existsSync(reportFile)) {
    return { reportFound: false, reportFile }
  }

  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  const specStats = { total: 0, expected: 0, unexpected: 0, flaky: 0, skipped: 0 }

  for (const suite of report.suites || []) {
    const stack = [...(suite.specs || [])]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current?.specs) {
        stack.push(...current.specs)
        continue
      }
      if (!current) continue
      specStats.total += 1
      const status = current.ok === true ? 'expected' : current.tests?.some((entry) => entry.status === 'flaky') ? 'flaky' : 'unexpected'
      specStats[status] += 1
      if (current.tests?.every((entry) => entry.status === 'skipped')) specStats.skipped += 1
    }
  }

  return {
    reportFound: true,
    reportFile,
    status: report.status,
    durationMs: report.stats?.duration ?? null,
    specs: specStats
  }
}

try {
  if (String(process.env.E2E_SKIP_RESET || '').toLowerCase() !== 'true') {
    await runCommandProcess({
      command: 'npm',
      args: ['run', 'reset:test-data'],
      label: 'Deterministic test-data reset',
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
  }

  mkdirSync(dirname(playwrightReport), { recursive: true })
  await runCommandProcess({
    command: 'npx',
    args: ['playwright', 'test', '--config=playwright.config.mjs'],
    label: 'Playwright E2E suite',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_REPORT: playwrightReport
    }
  })

  const summary = {
    ok: true,
    baseUrl: process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || null,
    deterministic: {
      retries: 0,
      workers: 1,
      resetTestData: String(process.env.E2E_SKIP_RESET || '').toLowerCase() !== 'true'
    },
    ...parsePlaywrightSummary(playwrightReport)
  }

  evidence.finalize({ status: 'passed', details: summary })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
} catch (error) {
  const summary = {
    ok: false,
    baseUrl: process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || null,
    deterministic: {
      retries: 0,
      workers: 1,
      resetTestData: String(process.env.E2E_SKIP_RESET || '').toLowerCase() !== 'true'
    },
    ...parsePlaywrightSummary(playwrightReport)
  }
  evidence.finalize({ status: 'failed', details: summary, error })
  throw error
}
