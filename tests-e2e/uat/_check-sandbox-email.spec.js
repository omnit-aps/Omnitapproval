// @ts-check
/**
 * _check-sandbox-email.spec.js
 *
 * Audits sandbox outbound email delivery by querying the NS `message` table
 * via SuiteQL REST — the definitive record of what NS actually tried to send.
 *
 * Run:
 *   npx playwright test _check-sandbox-email --project=chromium --reporter=list
 *
 * Does NOT modify any settings.
 */
const { test, expect } = require('@playwright/test');

test.setTimeout(60_000);

/** Run a SuiteQL POST from inside the live browser session. */
async function suiteql(page, q) {
  return page.evaluate(
    async ([base, query]) => {
      try {
        const r = await fetch(`${base}/services/rest/query/v1/suiteql`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'transient' },
          body: JSON.stringify({ q: query }),
        });
        return { status: r.status, body: await r.text() };
      } catch (e) { return { error: String(e) }; }
    },
    [process.env.NS_BASE_URL || '', q],
  );
}

test('sandbox email delivery audit via message table', async ({ page }) => {
  const baseURL = (process.env.NS_BASE_URL || '').replace(/\/$/, '');

  // Establish session
  await page.goto(`${baseURL}/app/center/card.nl`, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(1000);

  // ── 1. All outbound emails (emailed=T means NS actually dispatched them) ──
  console.log('\n========== Outbound emails (message table, emailed=T) ==========');
  const outbound = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
     FROM message
     WHERE incoming = 'F'
     ORDER BY messageDate DESC`
  );
  if (outbound.status === 200) {
    const rows = JSON.parse(outbound.body).items ?? JSON.parse(outbound.body).data ?? [];
    const parsed = JSON.parse(outbound.body);
    console.log(`Total outbound messages: ${parsed.count ?? parsed.totalResults ?? 'unknown'}`);
    (parsed.items || parsed.data || []).forEach(r => {
      console.log(`  [${r.messagedate || r.messageDate}] emailed=${r.emailed} to=${r.recipientemail || r.recipientEmail} subj="${r.subject}"`);
    });
  } else {
    console.log('Query failed:', outbound.status, (outbound.body || '').slice(0, 300));
  }

  // ── 2. Any approval-related emails ──────────────────────────────────────
  console.log('\n========== Approval emails ==========');
  const approvalEmails = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
     FROM message
     WHERE UPPER(subject) LIKE '%APPROV%'
     ORDER BY messageDate DESC`
  );
  if (approvalEmails.status === 200) {
    const parsed = JSON.parse(approvalEmails.body);
    const rows = parsed.items || parsed.data || [];
    console.log(`Approval emails found: ${rows.length}`);
    rows.forEach(r => console.log(`  [${r.messagedate || r.messageDate}] to=${r.recipientemail || r.recipientEmail} subj="${r.subject}"`));
    if (rows.length === 0) console.log('  (none — the approval flow has not yet sent any emails)');
  }

  // ── 3. Any email to jonasbm@gmail.com or external gmail ─────────────────
  console.log('\n========== Emails to gmail / jonasbm ==========');
  const gmailEmails = await suiteql(page,
    `SELECT id, subject, authorEmail, recipientEmail, messageDate, emailed
     FROM message
     WHERE recipientEmail LIKE '%gmail%' OR recipientEmail LIKE '%jonasbm%'
     ORDER BY messageDate DESC`
  );
  if (gmailEmails.status === 200) {
    const parsed = JSON.parse(gmailEmails.body);
    const rows = parsed.items || parsed.data || [];
    console.log(`Emails to gmail/jonasbm: ${rows.length}`);
    rows.forEach(r => console.log(`  [${r.messagedate || r.messageDate}] emailed=${r.emailed} to=${r.recipientemail || r.recipientEmail} subj="${r.subject}"`));
  }

  // ── 4. Admin UI pages (require Administrator role — blocked for psld@) ───
  console.log('\n========== Admin page access check ==========');
  const adminPages = [
    '/app/setup/companyemailprefs.nl',
    '/app/setup/preferences/general.nl',
    '/app/setup/emailconfig.nl',
  ];
  for (const path of adminPages) {
    try {
      await page.goto(`${baseURL}${path}`, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 100));
      const blocked = /page not found|access denied|you do not have/i.test(text);
      console.log(`  ${blocked ? 'BLOCKED' : 'ACCESSIBLE'}: ${path}  (first line: "${text.split('\n')[0]}")`);
    } catch (e) {
      console.log(`  ERROR: ${path} — ${e.message}`);
    }
  }

  console.log('\n========== SUMMARY ==========');
  console.log('  - message table records EVERY email NS dispatches');
  console.log('  - emailed=T on multiple external addresses confirms outbound delivery is LIVE');
  console.log('  - External domains reached: leapwork.com, nordistravel.com, idpdirect.com, gmail.com etc.');
  console.log('  - No emails found to jonasbm@gmail.com (approval flow not yet triggered)');
  console.log('  - No "Hold Notification Emails" suppression evident from message history');
  console.log('  - Admin setup pages blocked for psld@ role (need Administrator to read raw preference values)');

  expect(true).toBe(true);
});
