import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { browserFallbackMode, gatePlaywrightReportOrFail, main, validatePlaywrightJsonReport, writeTempReport } from './e2e-test.mjs'

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


test('validatePlaywrightJsonReport fails when report JSON is empty object', async () => {
  const reportPath = await writeTempReport('{}')
  const validation = await validatePlaywrightJsonReport(reportPath)

  assert.equal(validation.ok, false)
  assert.deepEqual(validation.suiteNames, [])
  assert.match(validation.artifact.reason, /contains no suite\/spec titles/)

  await rm(resolve(reportPath, '..'), { recursive: true, force: true })
})

test('validatePlaywrightJsonReport fails when suites/specs are present but untitled', async () => {
  const reportPath = await writeTempReport(
    JSON.stringify({
      suites: [{ specs: [{ tests: [{ status: 'passed' }] }] }],
      specs: [{}]
    })
  )
  const validation = await validatePlaywrightJsonReport(reportPath)

  assert.equal(validation.ok, false)
  assert.deepEqual(validation.suiteNames, [])
  assert.match(validation.artifact.reason, /contains no suite\/spec titles/)

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

  const validation = await gatePlaywrightReportOrFail({
    reportPath: missingPath,
    evidenceRecorder: fakeEvidence,
    uiContractStatus: { status: 'passed', exitCode: 0 }
  })

  assert.equal(validation.ok, false)
  assert.equal(evidenceFinalizeCalls.length, 1)
  assert.equal(evidenceFinalizeCalls[0].status, 'failed')
  assert.equal(evidenceFinalizeCalls[0].details.failureCategory, 'report-validation-failure')
  assert.match(evidenceFinalizeCalls[0].details.artifacts.playwrightJsonReport.reason, /Missing Playwright JSON report/)

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
    RELEASE_E2E_ALLOW_FALLBACK: '1'
  })

  assert.equal(mode.enabled, false)
  assert.equal(mode.flagEnabled, true)
  assert.equal(mode.isCi, true)
})

test('main fails in strict mode when browser binaries are missing', async () => {
  const finalizeCalls = []
  const exitCode = await main({
    createContext: async () => ({ port: 4100, shutdown: async () => {} }),
    run: async () => ({ code: 0, signal: null }),
    hasBrowser: async () => false,
    evidenceRecorder: { finalize: (payload) => finalizeCalls.push(payload) },
    removeFile: async () => {},
    validateReport: async () => ({ ok: true, suiteNames: ['playwright-browser-fallback'], artifact: { path: 'x', valid: true } }),
    writeFallbackReport: async () => {}
  })

  assert.equal(exitCode, 1)
  assert.equal(finalizeCalls.at(-1).status, 'failed')
  assert.equal(finalizeCalls.at(-1).details.failureCategory, 'browser-launch-failure')
  assert.equal(finalizeCalls.at(-1).details.browser.status, 'failed')
  assert.equal(finalizeCalls.at(-1).details.artifacts.playwrightJsonReport.valid, false)
})

test('main succeeds in fallback mode when browser binaries are missing', async () => {
  const finalizeCalls = []
  const originalFallback = process.env.RELEASE_E2E_ALLOW_FALLBACK
  process.env.RELEASE_E2E_ALLOW_FALLBACK = '1'

  try {
    const exitCode = await main({
      createContext: async () => ({ port: 4200, shutdown: async () => {} }),
      run: async () => ({ code: 0, signal: null }),
      hasBrowser: async () => false,
      evidenceRecorder: { finalize: (payload) => finalizeCalls.push(payload) },
      removeFile: async () => {},
      validateReport: async () => ({
        ok: true,
        suiteNames: ['playwright-browser-fallback'],
        artifact: { path: '/tmp/fallback-report.json', valid: true, suiteCount: 1 }
      }),
      writeFallbackReport: async () => {}
    })

    assert.equal(exitCode, 0)
    assert.equal(finalizeCalls.at(-1).status, 'passed')
    assert.equal(finalizeCalls.at(-1).fields.executionMode, 'fallback')
    assert.equal(finalizeCalls.at(-1).details.artifacts.playwrightJsonReport.valid, true)
  } finally {
    if (originalFallback === undefined) delete process.env.RELEASE_E2E_ALLOW_FALLBACK
    else process.env.RELEASE_E2E_ALLOW_FALLBACK = originalFallback
  }
})

test('main fails in strict mode when Playwright process fails', async () => {
  const finalizeCalls = []
  const exitCode = await main({
    createContext: async () => ({ port: 4300, shutdown: async () => {} }),
    run: async (command) => {
      if (command === process.execPath) return { code: 0, signal: null }
      return { code: 2, signal: null }
    },
    hasBrowser: async () => true,
    evidenceRecorder: { finalize: (payload) => finalizeCalls.push(payload) },
    removeFile: async () => {}
  })

  assert.equal(exitCode, 1)
  assert.equal(finalizeCalls.at(-1).status, 'failed')
  assert.equal(finalizeCalls.at(-1).details.failureCategory, 'browser-launch-failure')
  assert.equal(finalizeCalls.at(-1).details.browser.exitCode, 2)
  assert.equal(finalizeCalls.at(-1).details.artifacts.playwrightJsonReport.valid, false)
  assert.match(
    finalizeCalls.at(-1).details.artifacts.playwrightJsonReport.reason,
    /Playwright process failed before report validation/
  )
})

test('main classifies UI contract failures for one-hop triage', async () => {
  const finalizeCalls = []
  const exitCode = await main({
    createContext: async () => ({ port: 4350, shutdown: async () => {} }),
    run: async () => ({ code: 3, signal: null }),
    hasBrowser: async () => true,
    evidenceRecorder: { finalize: (payload) => finalizeCalls.push(payload) },
    removeFile: async () => {}
  })

  assert.equal(exitCode, 1)
  assert.equal(finalizeCalls.at(-1).details.failureCategory, 'ui-contract-failure')
})

test('main runs UI contract before browser suite and propagates strict env vars', async () => {
  const commands = []
  const exitCode = await main({
    createContext: async () => ({ port: 4400, shutdown: async () => {} }),
    run: async (command, args, env) => {
      commands.push({ command, args, env })
      if (command === process.execPath) return { code: 0, signal: null }
      await writeFile(
        env.PLAYWRIGHT_JSON_REPORT,
        JSON.stringify({
          suites: [{ title: 'release smoke' }]
        }),
        'utf8'
      )
      return { code: 0, signal: null }
    },
    hasBrowser: async () => true,
    evidenceRecorder: { finalize: () => {} },
    removeFile: async () => {},
    validateReport: async () => ({
      ok: true,
      suiteNames: ['release smoke'],
      artifact: { path: '/tmp/report.json', valid: true, suiteCount: 1 }
    })
  })

  assert.equal(exitCode, 0)
  assert.equal(commands.length, 2)
  assert.equal(commands[0].command, process.execPath)
  assert.deepEqual(commands[0].args.slice(0, 2), ['--test', 'apps/web/public/ui-contract.test.mjs'])
  assert.ok(commands[1].args.includes('playwright'))
  assert.equal(commands[1].env.RELEASE_E2E_PLAYWRIGHT_REPORT, commands[1].env.PLAYWRIGHT_JSON_REPORT)
  assert.equal(commands[1].env.TEST_RESET_BEHAVIOR, 'isolated')
})

test('main emits startup failure category when context boot throws', async () => {
  const finalizeCalls = []
  await assert.rejects(
    () =>
      main({
        createContext: async () => {
          throw new Error('boot failed')
        },
        evidenceRecorder: { finalize: (payload) => finalizeCalls.push(payload) }
      }),
    /boot failed/
  )

  assert.equal(finalizeCalls.at(-1).details.failureCategory, 'startup-failure')
})
