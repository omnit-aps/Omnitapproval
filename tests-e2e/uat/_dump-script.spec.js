// @ts-check
const { test, expect } = require('@playwright/test');
test('dump email_action SCRIPT (parent) record', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const resp = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  }, `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&dump_script=10448`);
  console.log('HTTP', resp.status);
  const data = JSON.parse(resp.body);
  for (const k of Object.keys(data.fields || {}).sort()) {
    if (/aud|allroles|allemp|public|extern|online|guest|anon|access|role|public/i.test(k)) {
      console.log(`  ${k} = ${JSON.stringify(data.fields[k])}`);
    }
  }
  expect(resp.status).toBe(200);
});
