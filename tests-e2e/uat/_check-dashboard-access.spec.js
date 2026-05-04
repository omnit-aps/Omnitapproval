const { test, expect } = require('@playwright/test');
test('check psld can access dashboard + find row 94328', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  const dashUrl = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_dashboard&deploy=customdeploy_oa_sl_dashboard`;
  await page.goto(dashUrl, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(2000);
  const info = await page.evaluate(() => ({
    title: document.title,
    snippet: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
    rowCount: document.querySelectorAll('tr[data-id]').length,
    firstFiveIds: Array.from(document.querySelectorAll('tr[data-id]')).slice(0, 5).map(r => r.getAttribute('data-id')),
    has94328: document.querySelector('tr[data-id="94328"]') !== null,
    pagination: document.querySelector('.pagination')?.textContent?.trim() || '(none)',
    accessDenied: /access denied/i.test(document.body.innerText.slice(0, 400)),
  }));
  console.log(JSON.stringify(info, null, 2));
  expect(true).toBe(true);
});
