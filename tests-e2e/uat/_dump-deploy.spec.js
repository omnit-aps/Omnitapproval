// @ts-check
const { test, expect } = require('@playwright/test');
test('dump email_action deployment fields', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const resp = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  }, `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&dump_deploy=customdeploy_oa_sl_email_action`);
  console.log('HTTP', resp.status);
  const data = JSON.parse(resp.body);
  console.log('Deployment internal id:', data.id);
  console.log('ALL fields:');
  for (const k of Object.keys(data.fields || {}).sort()) {
    console.log(`  ${k} = ${JSON.stringify(data.fields[k])}`);
  }
  expect(resp.status).toBe(200);
});
