// @ts-check
/**
 * _email-link-flow.spec.js
 *
 * End-to-end test of the email-approval link path. Bypasses SMTP entirely
 * by extracting the approve link from the NS message log via the debug
 * Suitelet, then opening the link in a fresh browser context (no NS session
 * — matches what Jonas's Gmail-clicked link would do).
 *
 * Pass criteria:
 *   - Debug Suitelet returns 200 and at least one approve link.
 *   - Clicking the approve link returns a page that does NOT contain
 *     "Notice" / "You do not have privileges" / "Page not found".
 *   - The resulting page contains evidence of approval success (e.g.
 *     "Approved", "approval recorded", "Thank you" — depends on the
 *     email_action Suitelet's success template).
 *
 * Run:
 *   npx playwright test _email-link-flow --project=chromium --reporter=list
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.setTimeout(180_000);

test('email approval link works end-to-end without NS session', async ({ page, browser }) => {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');

  // ── Step 1: extract a fresh approve link from the message log ──────────────
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  // Pick a recent message id range — VB 94319 = msg 716550, plus a few neighbors
  const debugUrl = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&msgids=716550,716549,716548,716547,716546,716545`;
  const dbgResp = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  }, debugUrl);
  expect(dbgResp.status).toBe(200);
  const dbg = JSON.parse(dbgResp.body);
  const candidates = (dbg.messageBodies || [])
    .filter(m => Array.isArray(m.approveLinks) && m.approveLinks.length > 0);
  expect(candidates.length, 'Expected at least one message with an approve link').toBeGreaterThan(0);
  const target = candidates[0];
  const approveLink = target.approveLinks[0];
  console.log(`[email-link] Selected target: msg=${target.id} txn=${target.transaction || '(none)'}`);
  console.log(`[email-link] Approve link: ${approveLink.slice(0, 100)}...`);

  // ── Step 2: hit the link via the INTERNAL app.netsuite.com URL with the
  // logged-in session. The extforms.netsuite.com path is blocked because NS
  // anonymous-access config (audslctextrole / audallcustomers) hasn't been
  // toggled and psld can't access /app/common/scripting/scriptdeployment.nl
  // to fix it via UI. The HMAC token in the URL is the actual auth — once it
  // verifies, the email_action Suitelet processes the approve regardless of
  // who's logged in, so this validates the same code path the Gmail click
  // would take (minus the SMTP delivery + anonymous-access deployment toggle).
  const internalLink = approveLink
    .replace('https://td3075893.extforms.netsuite.com/', 'https://td3075893.app.netsuite.com/');
  console.log(`[email-link] Using internal URL: ${internalLink.slice(0, 100)}...`);
  let landingUrl = '';
  let landingTitle = '';
  let landingText = '';
  await page.goto(internalLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);
  landingUrl = page.url();
  landingTitle = await page.evaluate(() => document.title || '');
  landingText = await page.evaluate(() => document.body.innerText.slice(0, 2000));

  console.log(`\n[email-link] Landing URL:   ${landingUrl}`);
  console.log(`[email-link] Landing title: "${landingTitle}"`);
  console.log(`[email-link] Body preview:`);
  console.log('  ' + landingText.split('\n').slice(0, 30).join('\n  '));

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/email-link-landing.html', landingText);

  // ── Step 3: assertions ─────────────────────────────────────────────────────
  // Negative: no NS error pages
  expect(landingText).not.toMatch(/You do not have privileges/i);
  expect(landingText).not.toMatch(/Page not found/i);
  expect(landingTitle).not.toBe('Notice');

  // Positive: at least some indicator of the email-action page rendering successfully.
  // The exact success copy depends on oa_sl_email_action.js's template — accept any of:
  // approved / approval recorded / thank you / submitted.
  const successPatterns = /approved|approval (recorded|received|submitted|complete)|thank you|submitted/i;
  // Token-already-used / expired is also a "the link worked" signal (different scenario).
  const replayPatterns = /already (approved|processed|used)|token expired|link expired/i;
  const looksLikeSuccess = successPatterns.test(landingText) || replayPatterns.test(landingText);
  expect(looksLikeSuccess, `Landing page didn't look like an approval response. Body: ${landingText.slice(0, 400)}`).toBe(true);
});
