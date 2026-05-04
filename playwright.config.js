// @ts-check
const { defineConfig, devices } = require('@playwright/test');
require('dotenv').config();

/**
 * Playwright config for OmnitApprovals NetSuite Suitelets.
 *
 * Auth model: a one-time interactive login produces tests-e2e/.auth/state.json,
 * which subsequent tests reuse via storageState. See tests-e2e/auth.setup.js.
 *
 * Required env (put in .env or export in shell):
 *   NS_BASE_URL   e.g. https://1234567-sb1.app.netsuite.com
 *   NS_EMAIL      sandbox login email
 *   NS_PASSWORD   sandbox login password
 */
module.exports = defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false, // NetSuite sessions don't love parallel logins from the same user
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.NS_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.js/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests-e2e/.auth/state.json',
      },
      dependencies: ['setup'],
    },
  ],
});
