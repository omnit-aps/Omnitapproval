const { test, expect } = require('@playwright/test');
const fs = require('fs');
test('capture OA analytics dashboard at HD', async ({ browser }) => {
  test.setTimeout(120_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const ctx = await browser.newContext({
    storageState: 'tests-e2e/.auth/state.json',
    viewport: { width: 1920, height: 1400 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_analytics&deploy=customdeploy_oa_sl_analytics`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(8000); // wait for Chart.js to render
  fs.mkdirSync('/Users/work/Omnitapproval/demo-screenshots-ns', { recursive: true });
  await page.screenshot({ path: '/Users/work/Omnitapproval/demo-screenshots-ns/50-oa-analytics-charts.png', fullPage: true, type: 'png' });
  console.log('Captured:', '/Users/work/Omnitapproval/demo-screenshots-ns/50-oa-analytics-charts.png');
  await ctx.close();
  expect(true).toBe(true);
});
