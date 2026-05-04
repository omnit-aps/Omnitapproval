const { test, expect } = require('@playwright/test');
const fs = require('fs');
test('extract a fresh approve link', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  // Pull recent message ids
  const sql = (q) => page.evaluate(async ([base, query]) => {
    const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
      body: JSON.stringify({ q: query }),
    });
    return JSON.parse(await r.text());
  }, [baseURL, q]);
  const recent = await sql(`SELECT id, transaction FROM message WHERE TRUNC(messageDate) >= TRUNC(CURRENT_DATE) - 2 AND recipientEmail = 'jonasbm@gmail.com' AND subject LIKE 'Approval required%' ORDER BY messageDate DESC FETCH FIRST 5 ROWS ONLY`);
  const ids = (recent.items || []).map(m => m.id).join(',');
  console.log('Recent msg ids:', ids);
  const dbgUrl = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&msgids=${ids}`;
  const dbg = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: 'include' }); return JSON.parse(await r.text()); }, dbgUrl);
  // Find one that's still pending (status=1) so the link can actually approve
  let target = null;
  for (const m of (dbg.messageBodies || [])) {
    if (!m.transaction || !m.approveLinks?.length) continue;
    const txnRow = (await sql(`SELECT approvalstatus FROM transaction WHERE id = ${m.transaction}`)).items?.[0];
    if (txnRow?.approvalstatus === '1') { target = m; break; }
  }
  if (!target) { console.log('No pending VB found in recent messages'); expect(true).toBe(true); return; }
  console.log(`Target: msg=${target.id} txn=${target.transaction}`);
  console.log(`Approve link: ${target.approveLinks[0]}`);
  fs.writeFileSync('/tmp/fresh-approve-link.txt', target.approveLinks[0]);
  expect(true).toBe(true);
});
