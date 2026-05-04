// @ts-check
const { test, expect } = require('@playwright/test');
test('fix isavailablewithoutlogin via debug Suitelet', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const url = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&fix_avail=customdeploy_oa_sl_email_action`;
  const resp = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, body: await r.text() }; }, url);
  console.log('HTTP', resp.status);
  console.log(resp.body);
  expect(resp.status).toBe(200);
});
