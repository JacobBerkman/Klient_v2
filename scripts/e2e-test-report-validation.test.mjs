import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { browserFallbackMode, gatePlaywrightReportOrFail, validatePlaywrightJsonReport, writeTempReport } from './e2e-test.mjs'

test('validatePlaywrightJsonReport fails when report is missing', async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), 'e2e-missing-'))
  const missingPath = resolve(tempDir, 'missing-report.json')
  const validation = await validatePlaywrightJsonReport(missingPath)

  assert.equal(validation.ok, false)
  assert.equal(validation.suiteNames.length, 0)
  assert.match(validation.artifact.reason, /Missing Playwright JSON report/)

  await rm(tempDir, { recursive: true, force: true })
})

test('validatePlaywrightJsonReport fails when report JSON is invalid', async () => {
  const reportPath = await writeTempReport('{ not-json')
  const validation = await validatePlaywrightJsonReport(reportPath)

  assert.equal(validation.ok, false)
  assert.equal(validation.suiteNames.length, 0)
  assert.match(validation.artifact.reason, /Invalid JSON in Playwright report/)

  await rm(resolve(reportPath, '..'), { recursive: true, force: true })
})

test('gatePlaywrightReportOrFail finalizes failed evidence with report reason', async () => {
  const evidenceFinalizeCalls = []
  const fakeEvidence = {
    finalize(payload) {
      evidenceFinalizeCalls.push(payload)
    }
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), 'e2e-gate-'))
  const missingPath = resolve(tempDir, 'nope.json')

  const previousExitCode = process.exitCode
  process.exitCode = 0
  const validation = await gatePlaywrightReportOrFail({
    reportPath: missingPath,
    evidenceRecorder: fakeEvidence,
    uiContractStatus: { status: 'passed', exitCode: 0 }
  })

  assert.equal(validation.ok, false)
  assert.equal(process.exitCode, 1)
  assert.equal(evidenceFinalizeCalls.length, 1)
  assert.equal(evidenceFinalizeCalls[0].status, 'failed')
  assert.match(evidenceFinalizeCalls[0].details.artifacts.playwrightJsonReport.reason, /Missing Playwright JSON report/)

  process.exitCode = previousExitCode
  await rm(tempDir, { recursive: true, force: true })
})

test('validatePlaywrightJsonReport collects suite/spec titles for release evidence', async () => {
  const reportPath = await writeTempReport(
    JSON.stringify({
      suites: [
        {
          title: 'Release smoke journey',
          specs: [{ title: 'submits onboarding form' }]
        }
      ]
    })
  )

  const validation = await validatePlaywrightJsonReport(reportPath)
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.suiteNames, ['Release smoke journey', 'submits onboarding form'])

  await rm(resolve(reportPath, '..'), { recursive: true, force: true })
})

test('browser fallback remains disabled in CI even when local fallback flag is set', () => {
  const mode = browserFallbackMode({
    CI: 'true',
    E2E_ALLOW_MISSING_BROWSER_FALLBACK: '1'
  })

  assert.equal(mode.enabled, false)
  assert.equal(mode.flagEnabled, true)
  assert.equal(mode.isCi, true)
})
