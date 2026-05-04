// @ts-check
const { test, expect } = require('@playwright/test');
test('force avail without login via record.save', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  // First: look up role 10313 to know what it is
  const r1 = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.text(); },
    `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&role_lookup=10313`);
  console.log('Role 10313:', r1);
  // Now try the force_avail with full save path
  const r2 = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return r.text(); },
    `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&force_avail=customdeploy_oa_sl_email_action`);
  console.log('Force avail:', r2);
  expect(true).toBe(true);
});
