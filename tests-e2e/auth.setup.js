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
test('authenticate', async ({ page, context }) => {
  test.setTimeout(180_000);
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

  // FAST PATH: if a saved state.json exists, try it first. If the cookie is
  // still valid we skip the login + security-question dance entirely. This is
  // critical because NS rotates between several security questions and each
  // login attempt can hit one we don't have a programmable answer for.
  if (fs.existsSync(STATE_FILE)) {
    try {
      const ctx = await page.context().browser().newContext({ storageState: STATE_FILE });
      const probe = await ctx.newPage();
      const resp = await probe.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      const url = probe.url();
      const isAuth = resp && resp.ok() && /app\.netsuite\.com\/(?!app\/login)(?:app|core|machine)/.test(url);
      await ctx.close();
      if (isAuth) {
        console.log('Existing state.json still valid — skipping fresh login.');
        return;
      }
      console.log('state.json present but expired — falling through to login.');
    } catch (e) {
      console.log('state.json probe failed; will re-auth:', e.message);
    }
  }

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
    // NS rotates between several question phrasings ("What was…", "In what city…",
    // "Where did…"). Match the cell next to the "Question:" label rather than a
    // single hard-coded prefix.
    let questionText = '';
    const questionCell = page.locator('td:has-text("Question:") + td, td:right-of(:text("Question:"))').first();
    const cellVisible = await questionCell.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (cellVisible) {
      questionText = (await questionCell.textContent())?.trim() || '';
    }
    if (!questionText) {
      // Fallback: pick the longest text node ending in "?" — the actual question
      // is the longest "?"-terminated string on this page.
      questionText = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('td, p, div, span'));
        const qs = all.map(el => (el.textContent || '').trim()).filter(t => /\?$/.test(t) && t.length < 200);
        qs.sort((a, b) => b.length - a.length);
        return qs[0] || '';
      });
    }
    if (!questionText) throw new Error('Could not locate security question on page');
    // The user's convention for these test accounts: answer is the last word of the question
    // (case-insensitive, with the trailing "?" stripped).
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
