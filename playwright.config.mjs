import { defineConfig } from '@playwright/test'
import { dirname, resolve } from 'node:path'

const baseURL =
  process.env.KLIENT_BASE_URL || process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`
const releaseEvidenceDir =
  process.env.RELEASE_EVIDENCE_DIR ||
  (process.env.RELEASE_EVIDENCE_E2E_FILE
    ? dirname(resolve(process.cwd(), process.env.RELEASE_EVIDENCE_E2E_FILE))
    : null) ||
  resolve(process.cwd(), 'artifacts', 'release-evidence')
const jsonReportFile =
  process.env.PLAYWRIGHT_JSON_REPORT ||
  process.env.RELEASE_E2E_PLAYWRIGHT_REPORT ||
  resolve(releaseEvidenceDir, 'playwright-report.json')
const configuredProjects = String(process.env.PLAYWRIGHT_BROWSER_PROJECTS || 'chromium')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean)
const includeProject = (name) => configuredProjects.includes(name) || configuredProjects.includes('all')

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  // Retries remain disabled; release gate reproducibility takes priority over flake masking.
  retries: 0,
  ...(process.env.PLAYWRIGHT_GREP ? { grep: new RegExp(process.env.PLAYWRIGHT_GREP, 'i') } : {}),
  reporter: [['list'], ['json', { outputFile: jsonReportFile }]],
  projects: [
    includeProject('chromium') && {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        locale: 'en-US',
        timezoneId: 'UTC'
      }
    },
    includeProject('firefox') && {
      name: 'firefox',
      use: {
        browserName: 'firefox',
        locale: 'en-US',
        timezoneId: 'UTC'
      }
    }
  ].filter(Boolean),
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  }
})
