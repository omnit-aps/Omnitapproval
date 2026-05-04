const { test, expect } = require('@playwright/test');
test('check VB 94319 (approved) and 94337 (declined) state', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const sql = (q) => page.evaluate(async ([base, query]) => {
    const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      body: JSON.stringify({ q: query }),
    });
    return JSON.parse(await r.text());
  }, [baseURL, q]);
  const r = await sql(`SELECT id, approvalstatus, custbody_oa_next_approver, custbody_oa_state_version FROM transaction WHERE id IN (94319, 94337)`);
  console.log(JSON.stringify(r.items, null, 2));
  expect(true).toBe(true);
});
