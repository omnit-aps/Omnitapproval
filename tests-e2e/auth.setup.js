// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '.auth');
const STATE_FILE = path.join(AUTH_DIR, 'state.json');

/**
 * One-time NetSuite UI login. Saves cookies to tests-e2e/.auth/state.json,
 * which all other tests reuse via storageState in playwright.config.js.
 *
 * Re-run when the session expires:
 *   npx playwright test --project=setup
 *
 * 2FA / SSO note: if your sandbox enforces 2FA, run this in headed mode
 * (HEADED=1) and complete the challenge interactively the first time.
 * The session cookie that gets saved will skip 2FA on subsequent test runs
 * until it expires.
 */
test('authenticate', async ({ page }) => {
  const baseURL = process.env.NS_BASE_URL;
  const email = process.env.NS_EMAIL;
  const password = process.env.NS_PASSWORD;

  if (!baseURL || !email || !password) {
    throw new Error(
      'Missing NS_BASE_URL / NS_EMAIL / NS_PASSWORD env vars. ' +
      'Set them in your shell or a .env file before running tests.'
    );
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  await page.goto(baseURL);

  // NetSuite login page selectors. These are stable across accounts.
  await page.locator('#userName, input[name="email"]').fill(email);
  await page.locator('#password, input[name="password"]').fill(password);
  await page.locator('#login-submit, button[type="submit"]').click();

  // Wait for either the home dashboard to load or a 2FA prompt to appear.
  // If 2FA appears and you're running headed, complete it manually within 2 min.
  await expect(page).toHaveURL(/app\.netsuite\.com\/(app|core|machine)/, {
    timeout: 120_000,
  });

  await page.context().storageState({ path: STATE_FILE });
});
