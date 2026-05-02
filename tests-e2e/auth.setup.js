// @ts-check
const { test } = require('@playwright/test');
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

  // NS may redirect a "new device" (Playwright's browser counts as one) to a
  // security-questions challenge page. The user's chosen convention: the
  // answer is the last word of the question (excluding the "?"). Handle that
  // automatically so headless test runs don't get blocked.
  //
  // NOTE: The "authenticated" URL predicate must exclude /app/login paths —
  // enterpriselogin.nl lives under /app/login/ and would otherwise match.
  /** @param {URL} u */
  const isAuthenticated = (u) => {
    const s = u.toString();
    return /app\.netsuite\.com\/(?!app\/login)(?:app|core|machine)/.test(s);
  };

  await page.waitForURL(
    (u) => isAuthenticated(u) || /securityquestions\.nl/.test(u.toString()),
    { timeout: 120_000 },
  );

  if (/securityquestions\.nl/.test(page.url())) {
    const questionText = (await page.getByText(/^What\b/i).first().textContent())?.trim() || '';
    // Strip trailing "?" and take the last word
    const answer = questionText.replace(/\?+\s*$/, '').trim().split(/\s+/).pop() || '';
    if (!answer) throw new Error(`Could not parse security question: "${questionText}"`);
    console.log(`Security question: "${questionText}" → answer: "${answer}"`);
    // "Hide Answer" checkbox makes the input type="password"; match either.
    await page.locator('input[type="password"], input[type="text"]').first().fill(answer);
    await page.locator('input[type="submit"], button:has-text("Submit")').first().click();
    await page.waitForURL(isAuthenticated, { timeout: 60_000 });
  } else if (/enterpriselogin\.nl|\/app\/login/.test(page.url())) {
    // Ended up on enterprise login / SSO page — wait for it to redirect to the app.
    await page.waitForURL(isAuthenticated, { timeout: 60_000 });
  }

  console.log('Post-login URL:', page.url());
  await page.screenshot({ path: 'test-results/auth-after-login.png', fullPage: true });

  await page.context().storageState({ path: STATE_FILE });
});
