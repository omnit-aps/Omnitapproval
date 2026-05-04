const { test, expect } = require('@playwright/test');
test('check OA enable_po setting', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const r = await page.evaluate(async ([base]) => {
    const x = await fetch(`${base}/services/rest/query/v1/suiteql`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      body: JSON.stringify({ q: `SELECT id, custrecord_oa_subsidiary, custrecord_oa_enable_po, custrecord_oa_enable_vb, custrecord_oa_default_approver1 FROM customrecord_oa_settings WHERE isinactive='F'` })
    });
    return JSON.parse(await x.text());
  }, [baseURL]);
  console.log(JSON.stringify(r.items, null, 2));
  expect(true).toBe(true);
});
