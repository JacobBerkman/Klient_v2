import { defineConfig } from '@playwright/test'

const baseURL = process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`
const jsonReportFile =
  process.env.PLAYWRIGHT_JSON_REPORT || process.env.RELEASE_E2E_PLAYWRIGHT_REPORT || 'artifacts/release-evidence/playwright-report.json'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: jsonReportFile }]],
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  }
})
