const { test, expect } = require('@playwright/test');
const fs = require('fs');
test('extract approve links from message bodies', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load' });
  const url = `${baseURL}/app/site/hosting/scriptlet.nl?script=customscript_oa_sl_debug&deploy=customdeploy_oa_sl_debug&msgids=716550,716549,716548,716547,716546,716545`;
  const resp = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  }, url);
  console.log('HTTP', resp.status);
  const data = JSON.parse(resp.body);
  fs.writeFileSync('test-results/email-bodies.json', JSON.stringify(data, null, 2));
  console.log('\n=== messageBodies ===');
  for (const m of data.messageBodies) {
    if (m.__error) { console.log(`  id=${m.id} ERROR: ${m.__error}`); continue; }
    console.log(`\n  id=${m.id} txn=${m.transaction} bodyLen=${m.bodyLength}`);
    console.log(`    subject: "${m.subject}"`);
    console.log(`    recipient: "${m.recipient}"`);
    console.log(`    approveLinks (${m.approveLinks.length}):`);
    m.approveLinks.forEach(l => console.log(`      ${l}`));
    console.log(`    rejectLinks (${m.rejectLinks.length}):`);
    m.rejectLinks.forEach(l => console.log(`      ${l}`));
    console.log(`    allLinks (${m.allLinks.length}):`);
    m.allLinks.slice(0, 5).forEach(l => console.log(`      ${l}`));
    console.log(`    bodyPreview:`);
    console.log(`      ${m.bodyPreview.replace(/\n/g, ' | ').slice(0, 400)}`);
  }
  expect(true).toBe(true);
});
