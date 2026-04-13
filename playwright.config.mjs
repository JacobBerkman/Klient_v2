import { defineConfig } from '@playwright/test'
import { dirname, resolve } from 'node:path'

const baseURL = process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`
const releaseEvidenceDir =
  process.env.RELEASE_EVIDENCE_DIR ||
  (process.env.RELEASE_EVIDENCE_E2E_FILE ? dirname(resolve(process.cwd(), process.env.RELEASE_EVIDENCE_E2E_FILE)) : null) ||
  resolve(process.cwd(), 'artifacts', 'release-evidence')
const jsonReportFile =
  process.env.PLAYWRIGHT_JSON_REPORT || process.env.RELEASE_E2E_PLAYWRIGHT_REPORT || resolve(releaseEvidenceDir, 'playwright-report.json')

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 75_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // Retries are opt-in at suite level for known transient-infra cases only.
  retries: 0,
  ...(process.env.PLAYWRIGHT_GREP ? { grep: new RegExp(process.env.PLAYWRIGHT_GREP, 'i') } : {}),
  reporter: [['list'], ['json', { outputFile: jsonReportFile }]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  }
})
