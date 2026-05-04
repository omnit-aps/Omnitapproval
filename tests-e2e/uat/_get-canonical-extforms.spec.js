const { test, expect } = require('@playwright/test');
test('canonical external URL after audience save', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const r = await page.evaluate(async (u) => { const x = await fetch(u, { credentials: 'include' }); return JSON.parse(await x.text()); },
    `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&dump_deploy=customdeploy_oa_sl_email_action`);
  console.log('externalurl:', r.fields.externalurl);
  console.log('isonline:   ', r.fields.isonline);
  console.log('runasrole:  ', r.fields.runasrole);
  console.log('audience:   ', r.fields.audience);
  console.log('audslctextrole:', JSON.stringify(r.fields.audslctextrole));
  console.log('allroles:   ', r.fields.allroles);
  console.log('allemployees:', r.fields.allemployees);
  expect(true).toBe(true);
});
