import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 3210);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `rm -f data/app.db && PORT=${port} node apps/api/src/server.mjs`,
    url: `${baseURL}/ready`,
    timeout: 60_000,
    reuseExistingServer: false
  }
});
