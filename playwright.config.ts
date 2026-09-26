import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a production build (`npm run test:e2e` builds first).
 * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use a preinstalled Chromium instead of
 * `npx playwright install chromium`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DATA_DIR: ".e2e-data", MIN_FREE_DISK_MB: "0" },
  },
});
