const { test, expect } = require('@playwright/test');
test('inspect last few POs created', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const r = await page.evaluate(async ([base]) => {
    const x = await fetch(`${base}/services/rest/query/v1/suiteql`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      body: JSON.stringify({ q: `SELECT  id, tranid, approvalstatus, custbody_oa_next_approver, custbody_oa_route_source FROM transaction WHERE type = 'PurchOrd' AND tranid = 'PO4477'` })
    });
    return { status: x.status, body: await x.text() };
  }, [baseURL]);
  console.log('STATUS:', r.status);
  console.log(r.body);
  expect(true).toBe(true);
});
