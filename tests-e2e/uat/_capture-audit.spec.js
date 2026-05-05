const { test, expect } = require('@playwright/test');
const fs = require('fs');
test('capture audit log Suitelet', async ({ browser }) => {
  test.setTimeout(120_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const ctx = await browser.newContext({
    storageState: 'tests-e2e/.auth/state.json',
    viewport: { width: 1920, height: 1400 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_audit&deploy=customdeploy_oa_sl_audit`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(3000);
  const title = await page.evaluate(() => document.title);
  console.log('Audit page title:', title);
  fs.mkdirSync('/Users/work/Omnitapproval/demo-screenshots-ns', { recursive: true });
  await page.screenshot({ path: '/Users/work/Omnitapproval/demo-screenshots-ns/60-oa-audit-log.png', fullPage: true });
  await ctx.close();
  expect(title).not.toMatch(/login|page not found|do not have privileges/i);
});
